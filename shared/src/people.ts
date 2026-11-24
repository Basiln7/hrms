/*
 * The rules for changing people: who may change whom, who may hold which role, who may be
 * whose manager, and when attendance counts for a person. The web app uses them to explain
 * before a request is sent; the API uses the same code to decide (plan.md, section 4).
 */
import { addDays, isLocalDate, type LocalDate } from './dates';
import { wouldLoop, type Employee, type EmploymentPeriod, type OrgNode } from './org';
import { can, canBeManager, isPrivileged, ROLES, type Role } from './roles';

export interface Department {
  id: string;
  name: string;
  createdAt: string;
}

type Who = Pick<OrgNode, 'id' | 'role'>;

/** The roles a person may give to someone else. */
export function grantableRoles(actorRole: Role): Role[] {
  if (can(actorRole, 'roles.assignPrivileged')) return [...ROLES];
  if (can(actorRole, 'roles.assign')) return ROLES.filter((role) => !isPrivileged(role));
  return [];
}

/**
 * Why `actor` may not change `target`'s account (their details, status or password), or null
 * when they may. HR manages people; only an Admin changes an HR or Admin account.
 */
export function accountBlocker(actor: Who, target: Who): string | null {
  if (!can(actor.role, 'employees.manage')) return 'Your role cannot manage employees.';
  if (isPrivileged(target.role) && !can(actor.role, 'roles.assignPrivileged')) return 'Only an Admin can change an HR or Admin account.';
  return null;
}

/** Why `actor` may not give `target` the role `next`, or null when they may. */
export function roleBlocker(actor: Who, target: Who, next: Role, people: readonly OrgNode[]): string | null {
  if (next === target.role) return null;
  // Nobody changes their own role, not even an Admin who is the only one: there is no exception to this.
  if (actor.id === target.id) return 'You cannot change your own role.';
  const account = accountBlocker(actor, target);
  if (account) return account;
  if (!grantableRoles(actor.role).includes(next)) return 'Only an Admin can give the HR and Admin roles.';
  if (!canBeManager(next) && people.some((p) => p.managerId === target.id && p.id !== target.id)) {
    return 'People still report to them. Move those people to another manager first.';
  }
  return null;
}

/**
 * Why `managerId` cannot be the manager of `employeeId`, or null when they can. `employeeId` is
 * null for someone who is being added and so reports to nobody yet.
 */
export function managerBlocker(people: readonly OrgNode[], employeeId: string | null, managerId: string): string | null {
  const manager = people.find((p) => p.id === managerId);
  if (!manager) return 'That manager does not exist.';
  if (manager.status === 'inactive') return 'A deactivated person cannot be made someone’s manager.';
  if (!canBeManager(manager.role)) return 'Only a Manager, HR or Admin can be someone’s manager. Change their role first.';
  if (employeeId !== null && wouldLoop(people, employeeId, managerId)) {
    return employeeId === managerId ? 'Nobody can be their own manager.' : 'That would put them above their own manager.';
  }
  return null;
}

/** The period attendance is counting for now, if any. */
export const openPeriod = (employment: readonly EmploymentPeriod[]): EmploymentPeriod | null => employment.find((p) => p.to === null) ?? null;

/** Whether attendance counts for a person on a date. Outside every period a day is "not applicable". */
export const isEmployedOn = (employment: readonly EmploymentPeriod[], date: LocalDate): boolean => employment.some((p) => p.from <= date && (p.to === null || date <= p.to));

/**
 * The periods after a deactivation with the given last working day, or the reason the day will
 * not do. A period that had not begun by then (someone added and removed before their first
 * day) is taken out, so it leaves no days to account for.
 */
export function closeEmployment(employment: readonly EmploymentPeriod[], lastDay: LocalDate, today: LocalDate): { employment: EmploymentPeriod[] } | { error: string } {
  if (!isLocalDate(lastDay)) return { error: 'Choose their last working day.' };
  if (lastDay > today) return { error: 'The last working day cannot be in the future. Deactivate them on or after that day.' };
  const open = openPeriod(employment);
  if (!open) return { employment: [...employment] };
  const closed = employment.filter((p) => p !== open);
  const previousEnd = closed.reduce<LocalDate | null>((latest, p) => (p.to && (!latest || p.to > latest) ? p.to : latest), null);
  if (previousEnd && lastDay <= previousEnd) return { error: 'The last working day must be after the end of their earlier time with the company.' };
  return { employment: lastDay < open.from ? closed : [...closed, { from: open.from, to: lastDay }] };
}

/**
 * The periods after a reactivation from the given day, or the reason the day will not do.
 * Someone who has never been given a schedule has no period to reopen: theirs opens with
 * their first one.
 */
export function reopenEmployment(employment: readonly EmploymentPeriod[], from: LocalDate, today: LocalDate, hasSchedule: boolean): { employment: EmploymentPeriod[] } | { error: string } {
  if (!isLocalDate(from)) return { error: 'Choose the day they are back from.' };
  if (from < today) return { error: 'They can be back from today at the earliest. Nothing is back-dated.' };
  if (from > addDays(today, 366)) return { error: 'Choose a day within the next year.' };
  if (openPeriod(employment) || !hasSchedule) return { employment: [...employment] };
  return { employment: [...employment, { from, to: null }] };
}

/**
 * The periods after a person's schedule assignments have changed. A person's first period
 * opens with their first assignment, and follows it while it has not begun (a planned start
 * moved or cancelled). A period that has begun is history and is never moved from here.
 */
export function employmentAfterAssignments(employment: readonly EmploymentPeriod[], starts: readonly LocalDate[], today: LocalDate): EmploymentPeriod[] {
  const firstNotBegun = employment.length === 1 && employment[0]!.to === null && employment[0]!.from > today;
  if (employment.length > 0 && !firstNotBegun) return [...employment];
  if (starts.length === 0) return [];
  const earliest = starts.reduce((min, d) => (d < min ? d : min));
  // Never earlier than today: nothing is back-dated, whatever old assignments exist.
  return [{ from: earliest < today ? today : earliest, to: null }];
}

/** The status someone gets when switched back on: Invited again if they have never signed in. */
export const reactivatedStatus = (employee: Pick<Employee, 'lastLoginAt'>): 'active' | 'invited' => (employee.lastLoginAt ? 'active' : 'invited');
