import type { Role } from './roles';

/** A person as recorded in the audit log: a snapshot, so the log survives renames and deletions. */
export interface AuditActor {
  id: string;
  name: string;
  role: Role;
}

/** One HR or admin action. The log is only ever added to. */
export interface AuditEvent {
  id: string;
  at: string;
  /** Who did it. Null for something the system did by itself. */
  actor: AuditActor | null;
  /** What was done, e.g. "settings.company.updated". */
  action: string;
  /** The kind of thing it was done to, and which one. */
  targetType: string;
  targetId: string | null;
  /** The employee it concerns, when it concerns one. */
  employeeId: string | null;
  /** One line a person can read. */
  summary: string;
  before?: unknown;
  after?: unknown;
  /** The actor did this to their own record as the only HR or Admin in the company (plan.md, D13). */
  selfAdministered?: boolean;
  ip?: string;
}

/** The parts of the HRMS an action can belong to, for narrowing the log. */
export const AUDIT_AREAS = ['people', 'schedules', 'holidays', 'attendance', 'leave', 'announcements', 'reports', 'settings'] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

/** Each area in words, and the first word of the actions it takes in ("employee.created" is under "employee"). */
export const AUDIT_AREA_INFO: Record<AuditArea, { label: string; prefixes: readonly string[] }> = {
  people: { label: 'People and departments', prefixes: ['employee', 'department'] },
  schedules: { label: 'Work schedules', prefixes: ['schedule'] },
  holidays: { label: 'Holidays', prefixes: ['holiday', 'holiday_calendar'] },
  attendance: { label: 'Attendance and corrections', prefixes: ['attendance', 'correction'] },
  leave: { label: 'Leave', prefixes: ['leave', 'leave_type', 'leave_policy'] },
  announcements: { label: 'Announcements', prefixes: ['announcement'] },
  reports: { label: 'Downloads', prefixes: ['report'] },
  settings: { label: 'Company settings', prefixes: ['settings', 'setup'] },
};

/** The area an action belongs to, or null for one this version does not know. */
export function auditAreaOf(action: string): AuditArea | null {
  const first = action.split('.')[0] ?? '';
  return AUDIT_AREAS.find((area) => AUDIT_AREA_INFO[area].prefixes.includes(first)) ?? null;
}

/** A row of the log as it is listed: with the name of the person it concerns, as they are called now. */
export interface AuditRow extends AuditEvent {
  employeeName: string | null;
}

export interface AuditListPayload {
  items: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Everyone who has ever done something that is in the log, by the name they had last. */
  actors: { id: string; name: string }[];
  /** The company's time zone: the log's times are shown on its clock. */
  timeZone: string;
}
