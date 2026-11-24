import {
  assignmentOn,
  employmentAfterAssignments,
  localDateOf,
  OWN_RECORD_MESSAGE,
  ownRecordVerdict,
  startBlocker,
  tidyRules,
  validateRules,
  type AssignmentInput,
  type AssignmentResult,
  type EmployeeSchedulePayload,
  type LocalDate,
  type OrgNode,
  type Schedule,
  type ScheduleAssignment,
  type ScheduleRow,
  type ScheduleRules,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, fromDoc, isDuplicateKey, nameKey, toDoc, type Account, type ScheduleDoc } from '../db';
import type { RequestContext } from '../http/context';
import { conflict, notFound, unprocessable } from '../http/errors';
import { newId } from '../ids';
import { loadOrg } from './access';
import { recordAudit, recordAudits, type AuditInput } from './audit';
import { calendarNames, defaultCalendarId } from './calendarStore';
import { leaveTouching } from './leaveStore';
import { loadCompany } from './settings';

/*
 * Work schedules and who is on them.
 *
 * A standard schedule is a named set of rules. An assignment gives one person a frozen copy
 * of some rules from a date. Editing a standard schedule therefore changes nobody: the people
 * on it keep the copy they were given, until HR gives them a new one from a date of its
 * choosing. Nothing is ever back-dated (plan.md, 6.2).
 */

export const toSchedule = ({ nameKey: _key, ...doc }: ScheduleDoc): Schedule => fromDoc<Schedule>(doc);

/** Rules as they are stored, or a refusal that names each field that is wrong. */
export function soundRules(raw: ScheduleRules, at = 'rules'): ScheduleRules {
  const rules = tidyRules(raw);
  const problems = validateRules(rules);
  const entries = Object.entries(problems);
  if (entries.length > 0) throw unprocessable(entries[0]![1], Object.fromEntries(entries.map(([path, message]) => [`${at}.${path}`, message])));
  return rules;
}

/** Whether an assignment is in force yet: its start date has arrived in its own time zone. */
const hasStarted = (assignment: Pick<ScheduleAssignment, 'effectiveFrom' | 'rules'>, now: Date) => assignment.effectiveFrom <= localDateOf(now, assignment.rules.timeZone);

/** A person's assignments, sorted into what applies now, what is planned, and the whole history. */
export function sortAssignments(assignments: readonly ScheduleAssignment[], now: Date) {
  const history = [...assignments].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const current = history.find((a) => hasStarted(a, now)) ?? null;
  const planned = history.filter((a) => !hasStarted(a, now)).reverse();
  return { current, planned, history };
}

/** Everyone's assignments, by person. */
export async function assignmentsOf(employeeIds: readonly string[]): Promise<Map<string, ScheduleAssignment[]>> {
  const byPerson = new Map<string, ScheduleAssignment[]>(employeeIds.map((id) => [id, []]));
  if (employeeIds.length === 0) return byPerson;
  const docs = await db().scheduleAssignments.find({ employeeId: { $in: [...employeeIds] } }).toArray();
  for (const doc of docs) byPerson.get(doc.employeeId)?.push(fromDoc<ScheduleAssignment>(doc));
  return byPerson;
}

/** The assignment each person works under today. People with none are left out. */
export async function currentAssignmentsOf(employeeIds: readonly string[]): Promise<Map<string, ScheduleAssignment>> {
  const now = clock.now();
  const found = new Map<string, ScheduleAssignment>();
  for (const [id, list] of await assignmentsOf(employeeIds)) {
    const { current } = sortAssignments(list, now);
    if (current) found.set(id, current);
  }
  return found;
}

/** The name of the schedule each person is on today. People with none are left out. */
export async function currentScheduleNames(employeeIds: readonly string[]): Promise<Map<string, string>> {
  return new Map([...(await currentAssignmentsOf(employeeIds))].map(([id, current]) => [id, current.rules.name]));
}

/** Today's date for a person: in the zone of the rules they work under, or the company's when they have none. */
export async function todayFor(employeeId: string): Promise<LocalDate> {
  const now = clock.now();
  const { current } = sortAssignments((await assignmentsOf([employeeId])).get(employeeId) ?? [], now);
  return localDateOf(now, current?.rules.timeZone ?? (await loadCompany()).timeZone);
}

export async function scheduleOf(employeeId: string): Promise<EmployeeSchedulePayload> {
  const now = clock.now();
  const sorted = sortAssignments((await assignmentsOf([employeeId])).get(employeeId) ?? [], now);
  const names = await calendarNames(sorted.history.map((a) => a.holidayCalendarId));
  return { today: localDateOf(now, sorted.current?.rules.timeZone ?? (await loadCompany()).timeZone), ...sorted, calendarNames: Object.fromEntries(names) };
}

/** For each standard schedule, the people working under a copy of it today, with the date since when. */
export async function peopleOnSchedules(): Promise<Map<string, { employeeId: string; effectiveFrom: LocalDate }[]>> {
  const now = clock.now();
  const [active, docs] = await Promise.all([
    db().employees.find({ status: { $ne: 'inactive' } }, { projection: { _id: 1 } }).toArray(),
    db().scheduleAssignments.find().toArray(),
  ]);
  const byPerson = new Map<string, ScheduleAssignment[]>(active.map((e) => [e._id, []]));
  for (const doc of docs) byPerson.get(doc.employeeId)?.push(fromDoc<ScheduleAssignment>(doc));
  const onSchedule = new Map<string, { employeeId: string; effectiveFrom: LocalDate }[]>();
  for (const [employeeId, list] of byPerson) {
    const { current } = sortAssignments(list, now);
    if (!current?.scheduleId) continue;
    const people = onSchedule.get(current.scheduleId) ?? [];
    people.push({ employeeId, effectiveFrom: current.effectiveFrom });
    onSchedule.set(current.scheduleId, people);
  }
  return onSchedule;
}

export async function scheduleRows(): Promise<ScheduleRow[]> {
  const [docs, people] = await Promise.all([db().schedules.find().sort({ nameKey: 1 }).toArray(), peopleOnSchedules()]);
  return docs.map((doc) => ({ ...toSchedule(doc), peopleCount: people.get(doc._id)?.length ?? 0 }));
}

const NAME_TAKEN = 'Another schedule already has that name.';

export async function createSchedule(ctx: RequestContext, raw: ScheduleRules): Promise<Schedule> {
  const rules = soundRules(raw);
  const now = clock.nowIso();
  const schedule: Schedule = { id: newId('sch'), name: rules.name, rules, archived: false, createdAt: now, updatedAt: now };
  try {
    await db().schedules.insertOne({ ...toDoc(schedule), nameKey: nameKey(schedule.name) });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(NAME_TAKEN, { 'rules.name': NAME_TAKEN });
    throw error;
  }
  await recordAudit(ctx, { action: 'schedule.created', targetType: 'schedule', targetId: schedule.id, summary: `Created the schedule "${schedule.name}".`, after: rules });
  return schedule;
}

/** Changes a standard schedule. Nobody's assignment is touched: people keep the copy they were given. */
export async function updateSchedule(ctx: RequestContext, id: string, raw: ScheduleRules): Promise<Schedule> {
  const existing = await db().schedules.findOne({ _id: id });
  if (!existing) throw notFound('That schedule no longer exists.');
  const rules = soundRules(raw);
  const updatedAt = clock.nowIso();
  try {
    await db().schedules.updateOne({ _id: id }, { $set: { name: rules.name, nameKey: nameKey(rules.name), rules, updatedAt } });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(NAME_TAKEN, { 'rules.name': NAME_TAKEN });
    throw error;
  }
  await recordAudit(ctx, { action: 'schedule.updated', targetType: 'schedule', targetId: id, summary: `Changed the schedule "${rules.name}". Nobody's own schedule was changed by this.`, before: existing.rules, after: rules });
  return { ...toSchedule(existing), name: rules.name, rules, updatedAt };
}

export async function archiveSchedule(ctx: RequestContext, id: string, archived: boolean): Promise<Schedule> {
  const existing = await db().schedules.findOne({ _id: id });
  if (!existing) throw notFound('That schedule no longer exists.');
  const updatedAt = clock.nowIso();
  await db().schedules.updateOne({ _id: id }, { $set: { archived, updatedAt } });
  await recordAudit(ctx, { action: archived ? 'schedule.archived' : 'schedule.restored', targetType: 'schedule', targetId: id, summary: `${archived ? 'Archived' : 'Restored'} the schedule "${existing.name}".` });
  return { ...toSchedule(existing), archived, updatedAt };
}

/** Brings a person's first employment period in line with their assignments (see `employmentAfterAssignments`). */
async function syncEmployment(employee: Pick<Account, 'id' | 'employment'>, today: LocalDate) {
  const starts = (await db().scheduleAssignments.find({ employeeId: employee.id }, { projection: { effectiveFrom: 1 } }).toArray()).map((a) => a.effectiveFrom);
  const next = employmentAfterAssignments(employee.employment, starts, today);
  if (JSON.stringify(next) !== JSON.stringify(employee.employment)) await db().employees.updateOne({ _id: employee.id }, { $set: { employment: next, updatedAt: clock.nowIso() } });
}

/**
 * Gives one or many people a schedule from a date. Each person is judged on their own: the
 * answer says who got it and, for everyone who did not, why. Nobody is skipped silently, and
 * a bulk action never reaches the person doing it (plan.md, D13).
 */
export async function assignSchedule(ctx: RequestContext, input: AssignmentInput, org?: readonly OrgNode[]): Promise<AssignmentResult> {
  let rules: ScheduleRules;
  let scheduleId: string | null = null;
  if (input.scheduleId) {
    const schedule = await db().schedules.findOne({ _id: input.scheduleId });
    if (!schedule) throw unprocessable('That schedule no longer exists.', { scheduleId: 'That schedule no longer exists.' });
    if (schedule.archived) throw unprocessable('That schedule is archived. Restore it before giving it to anyone.', { scheduleId: 'That schedule is archived.' });
    // The copy this person keeps, whatever happens to the standard schedule afterwards.
    rules = structuredClone(schedule.rules);
    scheduleId = schedule._id;
  } else if (input.rules) {
    rules = soundRules(input.rules);
  } else {
    throw unprocessable('Choose a standard schedule, or set the rules for this person.', { scheduleId: 'Choose a schedule.' });
  }

  // The holiday calendar goes with the schedule. Unless one is named, a person keeps the one they are
  // on at that date, and someone getting their first schedule gets the company default.
  if (input.holidayCalendarId && !(await db().holidayCalendars.findOne({ _id: input.holidayCalendarId }, { projection: { _id: 1 } }))) {
    throw unprocessable('That holiday calendar no longer exists.', { holidayCalendarId: 'That holiday calendar no longer exists.' });
  }
  const defaultCalendar = input.holidayCalendarId === undefined ? await defaultCalendarId() : null;

  const ids = [...new Set(input.employeeIds)];
  const [people, existing, everyone] = await Promise.all([db().employees.find({ _id: { $in: ids } }).toArray(), assignmentsOf(ids), org ? Promise.resolve(org) : loadOrg()]);
  const byId = new Map(people.map((p) => [p._id, p]));
  const ownRecord = ownRecordVerdict(ctx.employee, ids, everyone);
  const now = clock.now();
  const result: AssignmentResult = { assigned: [], skipped: [] };
  const audits: AuditInput[] = [];

  for (const id of ids) {
    const person = byId.get(id);
    if (!person) {
      result.skipped.push({ employeeId: id, name: '', reason: 'That person no longer exists.' });
      continue;
    }
    const skip = (reason: string) => result.skipped.push({ employeeId: id, name: person.name, reason });
    if (id === ctx.employee.id && ownRecord === 'blocked') {
      skip(OWN_RECORD_MESSAGE);
      continue;
    }
    if (person.status === 'inactive') {
      skip('They are deactivated. Reactivate them first.');
      continue;
    }
    const { current } = sortAssignments(existing.get(id) ?? [], now);
    const today = localDateOf(now, current?.rules.timeZone ?? rules.timeZone);
    const blocked = startBlocker(input.effectiveFrom, today, current !== null);
    if (blocked) {
      skip(blocked);
      continue;
    }

    const inForce = assignmentOn(existing.get(id) ?? [], input.effectiveFrom);
    const assignment: ScheduleAssignment = {
      id: newId('asg'),
      employeeId: id,
      effectiveFrom: input.effectiveFrom,
      scheduleId,
      rules,
      holidayCalendarId: input.holidayCalendarId !== undefined ? input.holidayCalendarId : inForce ? inForce.holidayCalendarId : defaultCalendar,
      note: input.note,
      createdBy: ctx.employee.id,
      createdByName: ctx.employee.name,
      createdAt: now.toISOString(),
    };
    // A planned assignment for the same date is replaced: it has not started, so it is not yet history.
    const replaced = await db().scheduleAssignments.findOneAndDelete({ employeeId: id, effectiveFrom: input.effectiveFrom });
    try {
      await db().scheduleAssignments.insertOne(toDoc(assignment));
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      skip('Someone else gave them a schedule from that date at the same moment. Check their schedule and try again.');
      continue;
    }
    await syncEmployment({ id, employment: person.employment }, today);
    result.assigned.push({ employeeId: id, name: person.name });
    audits.push({
      action: 'schedule.assigned',
      targetType: 'schedule_assignment',
      targetId: assignment.id,
      employeeId: id,
      summary: `Gave ${person.name} the ${scheduleId ? 'schedule' : 'custom schedule'} "${rules.name}" from ${input.effectiveFrom}.`,
      before: replaced ? { replacedPlanned: replaced.rules.name } : undefined,
      after: { scheduleId, name: rules.name, effectiveFrom: input.effectiveFrom, note: input.note || undefined },
      selfAdministered: id === ctx.employee.id && ownRecord === 'self_administered',
    });
  }
  await recordAudits(ctx, audits);
  // Leave already asked for from that date on was counted with the schedule as it was: say which requests those are.
  const touched = await leaveTouching(result.assigned.map((a) => a.employeeId), input.effectiveFrom, null);
  if (touched.length > 0) result.leave = touched;
  return result;
}

/** Cancels a planned assignment. One that has started is history and stays. */
export async function cancelAssignment(ctx: RequestContext, id: string, guard: (employeeId: string) => Promise<{ selfAdministered: boolean }>) {
  const doc = await db().scheduleAssignments.findOne({ _id: id });
  if (!doc) throw notFound('That planned schedule no longer exists.');
  const now = clock.now();
  if (hasStarted(doc, now)) throw conflict('That schedule has already started, so it is part of their history and cannot be cancelled. Give them a new one from tomorrow instead.');
  const { selfAdministered } = await guard(doc.employeeId);
  const person = await db().employees.findOne({ _id: doc.employeeId });
  // Only while it still has not started: a start date arriving between the check above and here must not lose history.
  const removed = await db().scheduleAssignments.deleteOne({ _id: id, effectiveFrom: doc.effectiveFrom });
  if (removed.deletedCount === 0) throw notFound('That planned schedule no longer exists.');
  if (person) await syncEmployment({ id: person._id, employment: person.employment }, localDateOf(now, doc.rules.timeZone));
  await recordAudit(ctx, {
    action: 'schedule.assignment.cancelled',
    targetType: 'schedule_assignment',
    targetId: id,
    employeeId: doc.employeeId,
    summary: `Cancelled the planned schedule "${doc.rules.name}" from ${doc.effectiveFrom}${person ? ` for ${person.name}` : ''}.`,
    before: { scheduleId: doc.scheduleId, name: doc.rules.name, effectiveFrom: doc.effectiveFrom },
    selfAdministered,
  });
}
