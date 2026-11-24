/*
 * People, and who may see whom.
 *
 * These are the only functions that decide scope. The API runs them on every request that
 * names a person; the web app runs the same code to decide what to show. Scope follows
 * today's organisation (plan.md, D14).
 */
import type { LocalDate } from './dates';
import { can, isPrivileged, type Role } from './roles';

export type EmployeeStatus = 'invited' | 'active' | 'inactive';

/** A stretch of time attendance counts for. `to` is null while it is still running. */
export interface EmploymentPeriod {
  from: LocalDate;
  to: LocalDate | null;
}

/** A person as the API returns them: never includes credentials. */
export interface Employee {
  id: string;
  /** The human-readable number, e.g. EMP-0007. */
  code: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  departmentId: string | null;
  designation: string;
  managerId: string | null;
  /** A fact about the person (used for leave eligibility). Not the start of attendance: see `employment`. */
  joinDate: LocalDate | null;
  /** Attendance counts only inside these periods. Empty until the first schedule is assigned. */
  employment: EmploymentPeriod[];
  /** `invited` = account created by HR, not signed in yet. */
  status: EmployeeStatus;
  leavePolicyId: string | null;
  /** Set while they still hold a temporary password given out by HR. */
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export const EMPLOYEE_STATUS: Record<EmployeeStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'var(--green)' },
  invited: { label: 'Invited', tone: 'var(--amber)' },
  inactive: { label: 'Inactive', tone: 'var(--text-3)' },
};

/** What scope maths needs to know about a person. */
export interface OrgNode {
  id: string;
  managerId: string | null;
  role: Role;
  status: EmployeeStatus;
}

const byId = (people: readonly OrgNode[]) => new Map(people.map((p) => [p.id, p]));

/**
 * The managers above a person, nearest first. Stops if the chain loops or points at someone
 * who does not exist. Deactivated managers stay in the chain, so nobody falls out of sight
 * while they wait for a new manager.
 */
export function managerChain(people: readonly OrgNode[], id: string): string[] {
  const index = byId(people);
  const chain: string[] = [];
  const seen = new Set([id]);
  let current = index.get(id)?.managerId ?? null;
  while (current && !seen.has(current) && index.has(current)) {
    chain.push(current);
    seen.add(current);
    current = index.get(current)!.managerId;
  }
  return chain;
}

/** Everyone who reports to a person, directly or through their reports. Never includes the person. */
export function reportsOf(people: readonly OrgNode[], managerId: string): string[] {
  const children = new Map<string, string[]>();
  for (const p of people) {
    if (!p.managerId) continue;
    const list = children.get(p.managerId);
    if (list) list.push(p.id);
    else children.set(p.managerId, [p.id]);
  }
  const found = new Set<string>();
  const queue = [...(children.get(managerId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === managerId || found.has(id)) continue;
    found.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return [...found];
}

/** Whether making `managerId` the manager of `employeeId` would have someone manage themselves, directly or in a loop. */
export function wouldLoop(people: readonly OrgNode[], employeeId: string, managerId: string): boolean {
  if (employeeId === managerId) return true;
  return managerChain(people, managerId).includes(employeeId);
}

/** Who a person may see: everyone, their reports and themselves, or only themselves. */
export type Scope = { kind: 'all' } | { kind: 'team'; self: string; reports: ReadonlySet<string> } | { kind: 'self'; self: string };

export function scopeOf(viewer: Pick<OrgNode, 'id' | 'role'>, people: readonly OrgNode[]): Scope {
  if (can(viewer.role, 'employees.viewAll')) return { kind: 'all' };
  if (can(viewer.role, 'team.view')) return { kind: 'team', self: viewer.id, reports: new Set(reportsOf(people, viewer.id)) };
  return { kind: 'self', self: viewer.id };
}

/** Whether a scope reaches a person. Everyone reaches themselves. */
export function inScope(scope: Scope, targetId: string): boolean {
  if (scope.kind === 'all') return true;
  if (scope.self === targetId) return true;
  return scope.kind === 'team' && scope.reports.has(targetId);
}

/** The ids a scope reaches, or 'all'. For database queries. */
export function scopeIds(scope: Scope): 'all' | string[] {
  if (scope.kind === 'all') return 'all';
  return scope.kind === 'team' ? [scope.self, ...scope.reports] : [scope.self];
}

/**
 * Nobody uses an HR power on their own record (plan.md, D13).
 *
 * - `ok`: the action does not touch the person doing it.
 * - `self_administered`: it does, and they are an Admin who is the only HR or Admin in the
 *   company, so nobody else could do it. Allowed, and the audit log marks it.
 * - `blocked`: it does, and another HR or Admin exists who must do it instead.
 */
export type OwnRecordVerdict = 'ok' | 'self_administered' | 'blocked';

export const OWN_RECORD_MESSAGE = 'You cannot do this on your own record. Ask another HR or Admin.';

export function ownRecordVerdict(actor: Pick<OrgNode, 'id' | 'role'>, targetIds: readonly string[], people: readonly OrgNode[]): OwnRecordVerdict {
  if (!targetIds.includes(actor.id)) return 'ok';
  const anotherExists = people.some((p) => p.id !== actor.id && p.status !== 'inactive' && isPrivileged(p.role));
  return actor.role === 'Admin' && !anotherExists ? 'self_administered' : 'blocked';
}
