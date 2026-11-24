/*
 * Roles and what each may do. The table is fixed in code for this version (plan.md, D10):
 * roles are assigned to people; what a role may do is not editable in the app.
 *
 * Everyone, whatever their role, can use the HRMS for themselves (check in, see their own
 * attendance, leave and requests). That needs no permission: it is tied to the signed-in
 * person on the server.
 */

/** Roles in order of access. */
export const ROLES = ['Employee', 'Manager', 'HR', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Record<Role, { tone: string; summary: string }> = {
  Employee: { tone: 'var(--blue)', summary: 'Records their own attendance and leave.' },
  Manager: { tone: 'var(--violet)', summary: 'Also sees their reports, and approves their leave and corrections.' },
  HR: { tone: 'var(--accent-text)', summary: 'Manages people, schedules, holidays, leave and announcements.' },
  Admin: { tone: 'var(--amber)', summary: 'Everything HR can do, plus company settings, HR and Admin accounts and the audit log.' },
};

export const PERMISSIONS = [
  { id: 'team.view', group: 'Team', label: 'See their reports', hint: 'The attendance, calendar, leave and requests of the people who report to them.' },
  { id: 'team.approve', group: 'Team', label: 'Decide their reports’ requests', hint: 'Approve or reject leave and attendance corrections of the people who report to them.' },
  { id: 'employees.viewAll', group: 'People', label: 'See every employee', hint: 'Everyone in the company and their records.' },
  { id: 'employees.manage', group: 'People', label: 'Manage employees', hint: 'Add, edit, activate and deactivate people; set their department and manager; reset passwords.' },
  { id: 'roles.assign', group: 'People', label: 'Assign Employee and Manager roles', hint: 'Give or remove the Employee and Manager roles.' },
  { id: 'roles.assignPrivileged', group: 'People', label: 'Assign HR and Admin roles', hint: 'Give or remove the HR and Admin roles, and change an HR or Admin account.' },
  { id: 'schedules.manage', group: 'Attendance', label: 'Manage work schedules', hint: 'Standard schedules, and assigning or customising them per employee.' },
  { id: 'holidays.manage', group: 'Attendance', label: 'Manage holidays', hint: 'Holiday calendars and the holidays in them.' },
  { id: 'attendance.edit', group: 'Attendance', label: 'Correct attendance directly', hint: 'Change someone’s attendance with a reason, without a request.' },
  { id: 'leave.configure', group: 'Leave', label: 'Set up leave', hint: 'Leave types, policies and balance adjustments.' },
  { id: 'requests.approveAll', group: 'Leave', label: 'Decide anyone’s requests', hint: 'Approve or reject any leave or attendance correction.' },
  { id: 'announcements.manage', group: 'Company', label: 'Manage announcements', hint: 'Create, edit, pin and delete announcements.' },
  { id: 'reports.view', group: 'Insights', label: 'View reports', hint: 'Reports and attendance records. Managers see their reports only.' },
  { id: 'reports.export', group: 'Insights', label: 'Export reports', hint: 'Download reports as CSV, for the same people.' },
  { id: 'settings.manage', group: 'Company', label: 'Manage company settings', hint: 'Company name, time zone, leave year and defaults.' },
  { id: 'audit.view', group: 'Company', label: 'View the audit log', hint: 'Every HR and admin action, who did it and when.' },
] as const;

export type PermissionId = (typeof PERMISSIONS)[number]['id'];

export const ALL_PERMISSIONS: readonly PermissionId[] = PERMISSIONS.map((p) => p.id);

const HR_PERMISSIONS: readonly PermissionId[] = [
  'employees.viewAll',
  'employees.manage',
  'roles.assign',
  'schedules.manage',
  'holidays.manage',
  'attendance.edit',
  'leave.configure',
  'requests.approveAll',
  'announcements.manage',
  'reports.view',
  'reports.export',
];

export const ROLE_PERMISSIONS: Record<Role, readonly PermissionId[]> = {
  Employee: [],
  Manager: ['team.view', 'team.approve', 'reports.view', 'reports.export'],
  HR: HR_PERMISSIONS,
  Admin: [...HR_PERMISSIONS, 'roles.assignPrivileged', 'settings.manage', 'audit.view'],
};

/** Whether a role holds a permission. */
export const can = (role: Role, permission: PermissionId): boolean => ROLE_PERMISSIONS[role].includes(permission);

export const permissionsOf = (role: Role): PermissionId[] => [...ROLE_PERMISSIONS[role]];

export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

/** The roles that run the HRMS. Their own records are handled by another of them (plan.md, D13). */
export const PRIVILEGED_ROLES: readonly Role[] = ['HR', 'Admin'];
export const isPrivileged = (role: Role): boolean => PRIVILEGED_ROLES.includes(role);

/** The roles that may be named as someone's manager. */
export const MANAGING_ROLES: readonly Role[] = ['Manager', 'HR', 'Admin'];
export const canBeManager = (role: Role): boolean => MANAGING_ROLES.includes(role);
