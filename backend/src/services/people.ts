import { randomInt } from 'node:crypto';
import type { Filter } from 'mongodb';
import {
  accountBlocker,
  closeEmployment,
  grantableRoles,
  localDateOf,
  managerBlocker,
  reactivatedStatus,
  reopenEmployment,
  reportsOf,
  roleBlocker,
  scopeIds,
  startBlocker,
  type DepartmentRow,
  type Employee,
  type EmployeeFilters,
  type EmployeeInput,
  type EmployeeRow,
  type LocalDate,
  type NewEmployeeInput,
  type Page,
  type PersonOption,
  type TemporaryPasswordPayload,
} from '@delta-hrms/shared';
import { hashPassword } from '../auth/passwords';
import { revokeSessionsOf } from '../auth/sessions';
import { clock } from '../clock';
import { db, fromDoc, isDuplicateKey, nameKey, toDoc, type Account, type Doc } from '../db';
import type { RequestContext } from '../http/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../http/errors';
import { newId } from '../ids';
import { assertInScope, guardOwnRecord, loadOrg, scopeFor } from './access';
import { addAdmin, LAST_ADMIN_MESSAGE, rebuildAdmins, releaseAdmin } from './admins';
import { recordAudit } from './audit';
import { nextEmployeeCode, toPublic } from './employees';
import { calendarNames } from './calendarStore';
import { openAccount } from './leaveAccounts';
import { defaultPolicyId } from './leaveStore';
import { todayOfEach } from './reports';
import { assignSchedule, currentAssignmentsOf, currentScheduleNames, todayFor } from './schedules';

/*
 * Adding, changing, deactivating and listing people. The rules (who may change whom, who
 * may hold which role, who may be whose manager) are the shared functions the web app also
 * runs; here they are enforced, because a request can be sent without the app.
 */

export const PAGE_SIZE = 25;

/** Unambiguous when read aloud or copied by hand: no 0/O, 1/l/i. */
const PASSWORD_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A temporary password such as "kq7m-x2pd-9fwt": about 59 bits, shown once and replaced at first sign-in. */
export function temporaryPassword(): string {
  const group = () => Array.from({ length: 4 }, () => PASSWORD_LETTERS[randomInt(PASSWORD_LETTERS.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

/** Search text as a pattern that matches it literally: what someone types is never read as a pattern. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function namesOf(collection: 'departments' | 'employees', ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const docs = await (db()[collection] as ReturnType<typeof db>['departments']).find({ _id: { $in: wanted } }, { projection: { name: 1 } }).toArray();
  return new Map(docs.map((d) => [d._id, d.name]));
}

/** People as a list shows them: with the names of their department, manager and schedule. */
export async function toRows(accounts: Account[]): Promise<EmployeeRow[]> {
  const [departments, managers, schedules] = await Promise.all([
    namesOf('departments', accounts.map((a) => a.departmentId)),
    namesOf('employees', accounts.map((a) => a.managerId)),
    currentScheduleNames(accounts.map((a) => a.id)),
  ]);
  return accounts.map((a) => ({
    ...toPublic(a),
    departmentName: (a.departmentId && departments.get(a.departmentId)) || null,
    managerName: (a.managerId && managers.get(a.managerId)) || null,
    scheduleName: schedules.get(a.id) ?? null,
  }));
}

/**
 * One page of the people the caller may see. `team` narrows it to the people who report to
 * the caller, directly or through their reports, whatever the caller's role.
 */
export async function listEmployees(ctx: RequestContext, filters: EmployeeFilters & { team?: boolean }): Promise<Page<EmployeeRow>> {
  const org = await loadOrg();
  const visible = scopeIds(await scopeFor(ctx, org));
  const conditions: Filter<Doc<Account>>[] = [];
  if (filters.team) conditions.push({ _id: { $in: reportsOf(org, ctx.employee.id) } });
  else if (visible !== 'all') conditions.push({ _id: { $in: visible } });
  if (filters.search) {
    const pattern = { $regex: literally(filters.search), $options: 'i' };
    conditions.push({ $or: [{ name: pattern }, { email: pattern }, { code: pattern }, { designation: pattern }] });
  }
  if (filters.departmentId) conditions.push({ departmentId: filters.departmentId === 'none' ? null : filters.departmentId });
  if (filters.managerId) conditions.push({ managerId: filters.managerId });
  if (filters.role) conditions.push({ role: filters.role });
  if (filters.status) conditions.push({ status: filters.status });
  const query: Filter<Doc<Account>> = conditions.length > 0 ? { $and: conditions } : {};

  const page = Math.max(1, filters.page ?? 1);
  const [total, docs] = await Promise.all([
    db().employees.countDocuments(query),
    db().employees.find(query).sort({ name: 1, _id: 1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray(),
  ]);
  const accounts = docs.map((d) => fromDoc<Account>(d));
  const rows = await toRows(accounts);
  // A manager's team comes with each person's day today: the people on this page only, read in one go.
  if (filters.team) {
    const today = await todayOfEach(accounts);
    for (const row of rows) row.today = today.get(row.id);
  }
  return { items: rows, total, page, pageSize: PAGE_SIZE };
}

/** Everyone who is not deactivated, in brief and by name, for forms that choose people. */
export async function pickerRows(): Promise<PersonOption[]> {
  const docs = await db()
    .employees.find({ status: { $ne: 'inactive' } }, { projection: { name: 1, code: 1, role: 1, departmentId: 1 } })
    .sort({ name: 1, _id: 1 })
    .limit(5000)
    .toArray();
  const [departments, current] = await Promise.all([namesOf('departments', docs.map((d) => d.departmentId)), currentAssignmentsOf(docs.map((d) => d._id))]);
  const calendars = await calendarNames([...current.values()].map((a) => a.holidayCalendarId));
  return docs.map((d) => ({
    id: d._id,
    code: d.code,
    name: d.name,
    role: d.role,
    departmentId: d.departmentId,
    departmentName: (d.departmentId && departments.get(d.departmentId)) || null,
    scheduleName: current.get(d._id)?.rules.name ?? null,
    calendarName: calendars.get(current.get(d._id)?.holidayCalendarId ?? '') ?? null,
  }));
}

/** One person, if the caller may see them. Otherwise "not found", exactly as for nobody. */
export async function getEmployee(ctx: RequestContext, id: string): Promise<EmployeeRow> {
  await assertInScope(ctx, id);
  const doc = await db().employees.findOne({ _id: id });
  if (!doc) throw notFound('That person does not exist.');
  return (await toRows([fromDoc<Account>(doc)]))[0]!;
}

async function findTarget(id: string): Promise<Account> {
  const doc = await db().employees.findOne({ _id: id });
  if (!doc) throw notFound('That person does not exist.');
  return fromDoc<Account>(doc);
}

const EMAIL_TAKEN = 'Another person already has that email address.';

/** Checks the parts of a person's record that point at other records. */
async function checkPlacement(input: EmployeeInput, employeeId: string | null, managerChanged: boolean) {
  if (input.departmentId && !(await db().departments.findOne({ _id: input.departmentId }, { projection: { _id: 1 } }))) {
    throw unprocessable('That department no longer exists.', { departmentId: 'That department no longer exists.' });
  }
  if (input.managerId && managerChanged) {
    const blocked = managerBlocker(await loadOrg(), employeeId, input.managerId);
    if (blocked) throw unprocessable(blocked, { managerId: blocked });
  }
}

export async function createEmployee(ctx: RequestContext, input: NewEmployeeInput): Promise<TemporaryPasswordPayload> {
  if (!grantableRoles(ctx.employee.role).includes(input.role)) throw forbidden('Only an Admin can give the HR and Admin roles.');
  if (await db().employees.findOne({ email: input.email }, { projection: { _id: 1 } })) throw unprocessable(EMAIL_TAKEN, { email: EMAIL_TAKEN });
  await checkPlacement(input, null, true);

  // The first schedule is checked before anyone is created, so a bad date cannot leave a person half set up.
  if (input.schedule) {
    if (!ctx.can('schedules.manage')) throw forbidden('Your role cannot give people a schedule.');
    const schedule = await db().schedules.findOne({ _id: input.schedule.scheduleId });
    if (!schedule || schedule.archived) throw unprocessable('Choose a schedule that is in use.', { 'schedule.scheduleId': 'Choose a schedule that is in use.' });
    const blocked = startBlocker(input.schedule.effectiveFrom, localDateOf(clock.now(), schedule.rules.timeZone), false);
    if (blocked) throw unprocessable(blocked, { 'schedule.effectiveFrom': blocked });
  }

  const { schedule, ...details } = input;
  const password = temporaryPassword();
  const now = clock.nowIso();
  const account: Account = {
    id: newId('emp'),
    code: await nextEmployeeCode(),
    ...details,
    employment: [],
    // Invited until they sign in for the first time, which is also when they must choose their own password.
    status: 'invited',
    // New people go on the company's default leave policy, when there is one. HR can move them afterwards.
    leavePolicyId: await defaultPolicyId(),
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
    passwordHash: await hashPassword(password),
  };
  try {
    await db().employees.insertOne(toDoc(account));
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(EMAIL_TAKEN, { email: EMAIL_TAKEN });
    throw error;
  }
  if (account.role === 'Admin') await addAdmin(account.id);
  await recordAudit(ctx, { action: 'employee.created', targetType: 'employee', targetId: account.id, employeeId: account.id, summary: `Added ${account.name} (${account.code}) as ${account.role}.`, after: toPublic(account) });
  if (schedule) await assignSchedule(ctx, { employeeIds: [account.id], scheduleId: schedule.scheduleId, rules: null, effectiveFrom: schedule.effectiveFrom, note: '' });
  // Their leave account for this leave year is opened now, so the allowance is granted under the policy as it is today.
  if (account.leavePolicyId) await openAccount(account.id);
  return { employee: toPublic((await findTarget(account.id))), temporaryPassword: password };
}

const CHANGEABLE = ['name', 'email', 'phone', 'role', 'departmentId', 'designation', 'managerId', 'joinDate'] as const;

export async function updateEmployee(ctx: RequestContext, id: string, input: EmployeeInput): Promise<Employee> {
  const target = await findTarget(id);
  const org = await loadOrg();
  // Your own record is someone else's to change (D13). A lone Admin may, but never their own role.
  const { selfAdministered } = await guardOwnRecord(ctx, [id], org);
  const account = accountBlocker(ctx.employee, target);
  if (account) throw forbidden(account);
  const role = roleBlocker(ctx.employee, target, input.role, org);
  if (role) throw role.startsWith('People still report') ? conflict(role) : forbidden(role);
  if (input.email !== target.email && (await db().employees.findOne({ email: input.email, _id: { $ne: id } }, { projection: { _id: 1 } }))) {
    throw unprocessable(EMAIL_TAKEN, { email: EMAIL_TAKEN });
  }
  await checkPlacement(input, id, input.managerId !== target.managerId);

  const leavingAdmin = target.role === 'Admin' && input.role !== 'Admin' && target.status !== 'inactive';
  if (leavingAdmin && (await releaseAdmin(id)) === 'last_admin') throw conflict(LAST_ADMIN_MESSAGE);
  try {
    await db().employees.updateOne({ _id: id }, { $set: { ...input, updatedAt: clock.nowIso() } });
  } catch (error) {
    // The guard list was changed first; put it back in line with the records before answering.
    if (leavingAdmin) await rebuildAdmins();
    if (isDuplicateKey(error)) throw unprocessable(EMAIL_TAKEN, { email: EMAIL_TAKEN });
    throw error;
  }
  if (input.role === 'Admin' && target.role !== 'Admin' && target.status !== 'inactive') await addAdmin(id);

  const changed = CHANGEABLE.filter((field) => input[field] !== target[field]);
  if (changed.length > 0) {
    await recordAudit(ctx, {
      action: input.role !== target.role ? 'employee.role.changed' : 'employee.updated',
      targetType: 'employee',
      targetId: id,
      employeeId: id,
      summary: input.role !== target.role ? `Changed ${target.name}'s role from ${target.role} to ${input.role}.` : `Changed ${target.name}'s details (${changed.join(', ')}).`,
      before: Object.fromEntries(changed.map((field) => [field, target[field]])),
      after: Object.fromEntries(changed.map((field) => [field, input[field]])),
      selfAdministered,
    });
  }
  return toPublic({ ...target, ...input });
}

/** Deactivates someone: closes their employment on their last working day and signs them out everywhere. */
export async function deactivateEmployee(ctx: RequestContext, id: string, lastWorkingDay: LocalDate): Promise<Employee> {
  const target = await findTarget(id);
  // No exception here, not even for a lone Admin: nobody switches themselves off.
  if (id === ctx.employee.id) throw badRequest('You cannot deactivate your own account.');
  const account = accountBlocker(ctx.employee, target);
  if (account) throw forbidden(account);
  if (target.status === 'inactive') throw conflict('They are already deactivated.');
  const closed = closeEmployment(target.employment, lastWorkingDay, await todayFor(id));
  if ('error' in closed) throw unprocessable(closed.error, { lastWorkingDay: closed.error });

  if (target.role === 'Admin' && (await releaseAdmin(id)) === 'last_admin') throw conflict(LAST_ADMIN_MESSAGE);
  await db().employees.updateOne({ _id: id }, { $set: { status: 'inactive', employment: closed.employment, updatedAt: clock.nowIso() } });
  await revokeSessionsOf([id]);
  await recordAudit(ctx, {
    action: 'employee.deactivated',
    targetType: 'employee',
    targetId: id,
    employeeId: id,
    summary: `Deactivated ${target.name}. Last working day: ${lastWorkingDay}.`,
    before: { status: target.status, employment: target.employment },
    after: { status: 'inactive', employment: closed.employment },
  });
  return toPublic({ ...target, status: 'inactive', employment: closed.employment });
}

/** Reactivates someone from a day, today at the earliest. The days in between stay outside their employment. */
export async function reactivateEmployee(ctx: RequestContext, id: string, from: LocalDate): Promise<Employee> {
  const target = await findTarget(id);
  const account = accountBlocker(ctx.employee, target);
  if (account) throw forbidden(account);
  if (target.status !== 'inactive') throw conflict('They are not deactivated.');
  const hasSchedule = (await db().scheduleAssignments.countDocuments({ employeeId: id }, { limit: 1 })) > 0;
  const reopened = reopenEmployment(target.employment, from, await todayFor(id), hasSchedule);
  if ('error' in reopened) throw unprocessable(reopened.error, { from: reopened.error });

  const status = reactivatedStatus(target);
  await db().employees.updateOne({ _id: id }, { $set: { status, employment: reopened.employment, updatedAt: clock.nowIso() } });
  if (target.role === 'Admin') await addAdmin(id);
  await recordAudit(ctx, {
    action: 'employee.reactivated',
    targetType: 'employee',
    targetId: id,
    employeeId: id,
    summary: `Reactivated ${target.name} from ${from}.`,
    before: { status: target.status, employment: target.employment },
    after: { status, employment: reopened.employment },
  });
  return toPublic({ ...target, status, employment: reopened.employment });
}

/** Gives someone a new temporary password, shown once, and signs them out everywhere. */
export async function resetPassword(ctx: RequestContext, id: string): Promise<TemporaryPasswordPayload> {
  const target = await findTarget(id);
  if (id === ctx.employee.id) throw badRequest('Change your own password from My profile.');
  const account = accountBlocker(ctx.employee, target);
  if (account) throw forbidden(account);
  if (target.status === 'inactive') throw conflict('They are deactivated. Reactivate them first.');

  const password = temporaryPassword();
  await db().employees.updateOne({ _id: id }, { $set: { passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: clock.nowIso() } });
  await revokeSessionsOf([id]);
  // The log says that it happened and who did it. Never the password.
  await recordAudit(ctx, { action: 'employee.password.reset', targetType: 'employee', targetId: id, employeeId: id, summary: `Gave ${target.name} a new temporary password.` });
  return { employee: toPublic({ ...target, mustChangePassword: true }), temporaryPassword: password };
}

/* ---------- Departments ---------- */

const DEPARTMENT_TAKEN = 'Another department already has that name.';

export async function departmentRows(withCounts: boolean): Promise<DepartmentRow[]> {
  const [docs, counts] = await Promise.all([
    db().departments.find().sort({ nameKey: 1 }).toArray(),
    withCounts
      ? db()
          .employees.aggregate<{ _id: string | null; n: number }>([{ $match: { status: { $ne: 'inactive' } } }, { $group: { _id: '$departmentId', n: { $sum: 1 } } }])
          .toArray()
      : Promise.resolve([]),
  ]);
  const byId = new Map(counts.map((c) => [c._id, c.n]));
  return docs.map((d) => ({ id: d._id, name: d.name, peopleCount: byId.get(d._id) ?? 0 }));
}

export async function createDepartment(ctx: RequestContext, name: string): Promise<DepartmentRow> {
  const id = newId('dep');
  try {
    await db().departments.insertOne({ _id: id, name, nameKey: nameKey(name), createdAt: clock.nowIso() });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(DEPARTMENT_TAKEN, { name: DEPARTMENT_TAKEN });
    throw error;
  }
  await recordAudit(ctx, { action: 'department.created', targetType: 'department', targetId: id, summary: `Created the department "${name}".` });
  return { id, name, peopleCount: 0 };
}

export async function renameDepartment(ctx: RequestContext, id: string, name: string) {
  const existing = await db().departments.findOne({ _id: id });
  if (!existing) throw notFound('That department no longer exists.');
  if (existing.name === name) return;
  try {
    await db().departments.updateOne({ _id: id }, { $set: { name, nameKey: nameKey(name) } });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(DEPARTMENT_TAKEN, { name: DEPARTMENT_TAKEN });
    throw error;
  }
  await recordAudit(ctx, { action: 'department.renamed', targetType: 'department', targetId: id, summary: `Renamed the department "${existing.name}" to "${name}".`, before: { name: existing.name }, after: { name } });
}

/** Deletes a department nobody is in. People are never left pointing at a department that is gone. */
export async function deleteDepartment(ctx: RequestContext, id: string) {
  const existing = await db().departments.findOne({ _id: id });
  if (!existing) throw notFound('That department no longer exists.');
  const people = await db().employees.countDocuments({ departmentId: id });
  if (people > 0) throw conflict(`${people} ${people === 1 ? 'person is' : 'people are'} still in ${existing.name}, counting anyone deactivated. Move them to another department first.`);
  await db().departments.deleteOne({ _id: id });
  await recordAudit(ctx, { action: 'department.deleted', targetType: 'department', targetId: id, summary: `Deleted the department "${existing.name}".`, before: { name: existing.name } });
}
