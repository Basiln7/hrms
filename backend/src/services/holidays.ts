import {
  addDays,
  assignmentOn,
  calendarNameProblem,
  calendarStartBlocker,
  CONFIRM_PAST,
  copyYear,
  evaluateDay,
  hasEffect,
  holidaysFor,
  localDateOf,
  shapeOf,
  OWN_RECORD_MESSAGE,
  ownRecordVerdict,
  validateHoliday,
  type AssignmentResult,
  type CalendarAssignInput,
  type CalendarDetailPayload,
  type CalendarListPayload,
  type CalendarRow,
  type CopyYearResult,
  type DayStatus,
  type Holiday,
  type HolidayCalendar,
  type HolidayEffect,
  type HolidayInput,
  type LocalDate,
  type MyHoliday,
  type MyHolidaysPayload,
  type ScheduleAssignment,
  type SchedulePerson,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, fromDoc, isDuplicateKey, nameKey, toDoc, type Account, type HolidayCalendarDoc } from '../db';
import type { RequestContext } from '../http/context';
import { conflict, needsConfirmation, notFound, unprocessable } from '../http/errors';
import { newId } from '../ids';
import { loadOrg } from './access';
import { buildContext, contextFor, inputFor, type PersonContext } from './attendance';
import { recordAudit, recordAudits, type AuditInput } from './audit';
import { calendarNames, defaultCalendarId, saveDefaultCalendar } from './calendarStore';
import { leaveSpansOf, leaveTouching } from './leaveStore';
import { assignmentsOf, sortAssignments } from './schedules';
import { loadCompany } from './settings';

/*
 * Holiday calendars and the holidays in them.
 *
 * A person is on a calendar through their schedule assignment, so which calendar applied on a
 * date is frozen with that assignment, and moving someone to another calendar starts on a day
 * that has not begun. The one way the past can still change is a holiday being added, changed
 * or removed on a date that has already begun: that is worked out first, shown to the person
 * doing it, done only when they confirm, and written to the audit log (plan.md, 6.7).
 */

const toCalendar = ({ nameKey: _key, ...doc }: HolidayCalendarDoc): HolidayCalendar => fromDoc<HolidayCalendar>(doc);

const NAME_TAKEN = 'Another calendar already has that name.';
const DATE_TAKEN = 'That date already has a holiday on this calendar.';

async function requireCalendar(id: string): Promise<HolidayCalendar> {
  const doc = await db().holidayCalendars.findOne({ _id: id });
  if (!doc) throw notFound('That holiday calendar no longer exists.');
  return toCalendar(doc);
}

function soundName(raw: string): string {
  const problem = calendarNameProblem(raw);
  if (problem) throw unprocessable(problem, { name: problem });
  return raw.trim();
}

/** For each calendar, the people on it today and since when; and how many people with a schedule are on none. */
async function peopleOnCalendars(now: Date) {
  const [active, docs] = await Promise.all([
    db().employees.find({ status: { $ne: 'inactive' } }, { projection: { _id: 1 } }).toArray(),
    db().scheduleAssignments.find({}, { projection: { rules: 0 } }).toArray(),
  ]);
  const byPerson = new Map<string, Pick<ScheduleAssignment, 'effectiveFrom' | 'holidayCalendarId'>[]>(active.map((e) => [e._id, []]));
  for (const doc of docs) byPerson.get(doc.employeeId)?.push(doc);
  // Whether an assignment has started is judged in the company's zone here: this is a head count, not a rule.
  const today = localDateOf(now, (await loadCompany()).timeZone);
  const on = new Map<string, { employeeId: string; effectiveFrom: LocalDate }[]>();
  let without = 0;
  for (const [employeeId, list] of byPerson) {
    const started = list.filter((a) => a.effectiveFrom <= today).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    const current = started[0];
    if (!current) continue;
    if (!current.holidayCalendarId) {
      without += 1;
      continue;
    }
    // Since when: back through every assignment in a row that named the same calendar.
    let since = current.effectiveFrom;
    for (const earlier of started) {
      if (earlier.holidayCalendarId !== current.holidayCalendarId) break;
      since = earlier.effectiveFrom;
    }
    const people = on.get(current.holidayCalendarId) ?? [];
    people.push({ employeeId, effectiveFrom: since });
    on.set(current.holidayCalendarId, people);
  }
  return { on, without };
}

const yearRange = (year: number) => ({ $gte: `${year}-01-01`, $lte: `${year}-12-31` });

async function rowsFor(docs: HolidayCalendarDoc[], year: number, now: Date): Promise<{ rows: CalendarRow[]; on: Awaited<ReturnType<typeof peopleOnCalendars>>['on']; without: number }> {
  const [defaultId, people, counts] = await Promise.all([
    defaultCalendarId(),
    peopleOnCalendars(now),
    db()
      .holidays.aggregate<{ _id: string; count: number }>([{ $match: { date: yearRange(year) } }, { $group: { _id: '$calendarId', count: { $sum: 1 } } }])
      .toArray(),
  ]);
  const countOf = new Map(counts.map((c) => [c._id, c.count]));
  const rows = docs.map((doc) => ({ ...toCalendar(doc), isDefault: doc._id === defaultId, holidayCount: countOf.get(doc._id) ?? 0, peopleCount: people.on.get(doc._id)?.length ?? 0 }));
  return { rows, on: people.on, without: people.without };
}

export async function calendarList(year: number): Promise<CalendarListPayload> {
  const docs = await db().holidayCalendars.find().sort({ nameKey: 1 }).toArray();
  const { rows, without } = await rowsFor(docs, year, clock.now());
  return { year, calendars: rows, withoutCalendar: without };
}

export async function calendarDetail(id: string, year: number): Promise<CalendarDetailPayload> {
  const doc = await db().holidayCalendars.findOne({ _id: id });
  if (!doc) throw notFound('That holiday calendar no longer exists.');
  const now = clock.now();
  const [{ rows, on }, holidays, dates, company] = await Promise.all([
    rowsFor([doc], year, now),
    db().holidays.find({ calendarId: id, date: yearRange(year) }).sort({ date: 1 }).toArray(),
    db().holidays.find({ calendarId: id }, { projection: { date: 1 } }).toArray(),
    loadCompany(),
  ]);
  const since = new Map((on.get(id) ?? []).map((p) => [p.employeeId, p.effectiveFrom]));
  const employees = await db()
    .employees.find({ _id: { $in: [...since.keys()] } }, { projection: { name: 1, code: 1, departmentId: 1, status: 1 } })
    .sort({ name: 1 })
    .toArray();
  const departments = new Map((await db().departments.find({}, { projection: { name: 1 } }).toArray()).map((d) => [d._id, d.name]));
  const people: SchedulePerson[] = employees.map((e) => ({ id: e._id, code: e.code, name: e.name, departmentName: (e.departmentId && departments.get(e.departmentId)) || null, status: e.status, effectiveFrom: since.get(e._id)! }));
  return {
    ...rows[0]!,
    year,
    today: localDateOf(now, company.timeZone),
    holidays: holidays.map((h) => fromDoc<Holiday>(h)),
    years: [...new Set(dates.map((d) => Number(d.date.slice(0, 4))))].sort((a, b) => a - b),
    people,
  };
}

export async function createCalendar(ctx: RequestContext, rawName: string): Promise<HolidayCalendar> {
  const name = soundName(rawName);
  const now = clock.nowIso();
  const calendar: HolidayCalendar = { id: newId('cal'), name, createdAt: now, updatedAt: now };
  try {
    await db().holidayCalendars.insertOne({ ...toDoc(calendar), nameKey: nameKey(name) });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(NAME_TAKEN, { name: NAME_TAKEN });
    throw error;
  }
  // The first calendar becomes the one preselected for new people. It can be changed afterwards.
  const becameDefault = (await defaultCalendarId()) === null;
  if (becameDefault) await saveDefaultCalendar(calendar.id);
  await recordAudit(ctx, { action: 'holiday_calendar.created', targetType: 'holiday_calendar', targetId: calendar.id, summary: `Created the holiday calendar "${name}"${becameDefault ? ', which became the company default' : ''}.`, after: { name } });
  return calendar;
}

export async function renameCalendar(ctx: RequestContext, id: string, rawName: string): Promise<HolidayCalendar> {
  const existing = await requireCalendar(id);
  const name = soundName(rawName);
  const updatedAt = clock.nowIso();
  try {
    await db().holidayCalendars.updateOne({ _id: id }, { $set: { name, nameKey: nameKey(name), updatedAt } });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(NAME_TAKEN, { name: NAME_TAKEN });
    throw error;
  }
  await recordAudit(ctx, { action: 'holiday_calendar.renamed', targetType: 'holiday_calendar', targetId: id, summary: `Renamed the holiday calendar "${existing.name}" to "${name}".`, before: { name: existing.name }, after: { name } });
  return { ...existing, name, updatedAt };
}

/** Makes a calendar the one preselected for people getting their first schedule. Nobody already on a schedule is changed. */
export async function makeDefaultCalendar(ctx: RequestContext, id: string) {
  const calendar = await requireCalendar(id);
  const before = await defaultCalendarId();
  if (before === id) return;
  await saveDefaultCalendar(id);
  await recordAudit(ctx, { action: 'holiday_calendar.made_default', targetType: 'holiday_calendar', targetId: id, summary: `Made "${calendar.name}" the company's default holiday calendar. Nobody's own calendar was changed by this.`, before: { defaultCalendarId: before }, after: { defaultCalendarId: id } });
}

/** Deletes a calendar nobody is, was or is about to be on. One that is part of anyone's schedule history has to stay, or their past would lose its holidays. */
export async function deleteCalendar(ctx: RequestContext, id: string) {
  const calendar = await requireCalendar(id);
  const used = await db().scheduleAssignments.countDocuments({ holidayCalendarId: id });
  if (used > 0) throw conflict(`"${calendar.name}" is part of people's schedules, now or in their history, so it has to stay: their past days read their holidays from it. Move people to another calendar instead.`);
  const holidays = await db().holidays.countDocuments({ calendarId: id });
  await db().holidays.deleteMany({ calendarId: id });
  await db().holidayCalendars.deleteOne({ _id: id });
  if ((await defaultCalendarId()) === id) await saveDefaultCalendar(null);
  await recordAudit(ctx, { action: 'holiday_calendar.deleted', targetType: 'holiday_calendar', targetId: id, summary: `Deleted the holiday calendar "${calendar.name}", which nobody was ever on, with its ${holidays} ${holidays === 1 ? 'holiday' : 'holidays'}.`, before: { name: calendar.name, holidays } });
}

function soundHoliday(raw: HolidayInput): HolidayInput {
  const input: HolidayInput = { date: raw.date, name: raw.name.trim(), type: raw.type, description: raw.description.trim() };
  const problems = validateHoliday(input);
  const entries = Object.entries(problems);
  if (entries.length > 0) throw unprocessable(entries[0]![1], problems);
  return input;
}

/**
 * What a change to this calendar's holidays would do that HR should see first.
 *
 * Everyone who was ever on the calendar is looked at, on the dates the change touches.
 * - A day counts when the person was on this calendar on that date, the date has begun for
 *   them, and the engine reads it differently with the holidays as they would be.
 * - A leave request counts, on any date, past or to come, when it includes a date whose kind
 *   of day (working, holiday) changes for that person: its days were counted with the
 *   calendar as it was, and stay as they were counted.
 * Nothing is written.
 */
async function effectOf(calendarId: string, dates: readonly LocalDate[], change: (current: Holiday[]) => Holiday[]): Promise<HolidayEffect> {
  const empty: HolidayEffect = { people: 0, changes: [] };
  const ids = await db().scheduleAssignments.distinct('employeeId', { holidayCalendarId: calendarId });
  if (ids.length === 0) return empty;

  const now = clock.now();
  const sorted = [...dates].sort();
  const [employees, assignments, company, docs, leave] = await Promise.all([
    db().employees.find({ _id: { $in: ids } }, { projection: { employment: 1 } }).toArray(),
    assignmentsOf(ids),
    loadCompany(),
    db().attendanceDays.find({ employeeId: { $in: ids }, date: { $in: [...dates] } }).toArray(),
    leaveSpansOf(ids, { from: sorted[0]!, to: sorted[sorted.length - 1]! }),
  ]);
  const calendarIds = [...new Set([...assignments.values()].flat().map((a) => a.holidayCalendarId).filter((id): id is string => id !== null))];
  const holidaysNow = (await db().holidays.find({ calendarId: { $in: calendarIds } }).toArray()).map((doc) => fromDoc<Holiday>(doc));
  const holidaysAfter = [...holidaysNow.filter((h) => h.calendarId !== calendarId), ...change(holidaysNow.filter((h) => h.calendarId === calendarId))];
  const docOf = new Map(docs.map((doc) => [doc._id, doc]));

  const counts = new Map<string, { date: LocalDate; from: DayStatus; to: DayStatus; count: number }>();
  const people = new Set<string>();
  /** The person-days whose kind of day changes: "<employeeId>|<date>". */
  const reached = new Set<string>();
  for (const employee of employees) {
    const own = assignments.get(employee._id) ?? [];
    const person = { id: employee._id, employment: employee.employment };
    const spans = leave.get(employee._id) ?? [];
    const before: PersonContext = buildContext(person, own, holidaysNow, company.timeZone, now, undefined, spans);
    const after: PersonContext = buildContext(person, own, holidaysAfter, company.timeZone, now, undefined, spans);
    const today = localDateOf(now, before.timeZone);
    for (const date of dates) {
      if (assignmentOn(own, date)?.holidayCalendarId !== calendarId) continue;
      if (shapeOf(date, before.ctx)?.kind !== shapeOf(date, after.ctx)?.kind) reached.add(`${employee._id}|${date}`);
      if (date > today) continue;
      const doc = docOf.get(`${employee._id}|${date}`) ?? null;
      const from = evaluateDay(date, now, before.ctx, inputFor(doc, before)).status;
      const to = evaluateDay(date, now, after.ctx, inputFor(doc, after)).status;
      if (from === to) continue;
      people.add(employee._id);
      const key = `${date}|${from}|${to}`;
      const entry = counts.get(key) ?? { date, from, to, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  const touched = reached.size === 0 ? [] : await leaveTouching(ids, sorted[0]!, sorted[sorted.length - 1]!, (request) => dates.some((date) => request.startDate <= date && date <= request.endDate && reached.has(`${request.employeeId}|${date}`)));
  return { people: people.size, changes: [...counts.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.count - a.count)), ...(touched.length > 0 ? { leave: touched } : {}) };
}

/** Stops a change that would alter days that have begun, or that reaches into leave already asked for, unless the caller has seen what it does and said so. */
function confirmPast(effect: HolidayEffect, confirmed: boolean) {
  if (!hasEffect(effect) || confirmed) return;
  const message = effect.changes.length > 0 ? 'That date has already begun for people on this calendar. Confirm to change how their day reads.' : 'People on this calendar have asked for leave that includes that date. Confirm that you have seen which requests it touches.';
  throw needsConfirmation(message, CONFIRM_PAST, effect);
}

function effectNote(effect: HolidayEffect) {
  const days = effect.changes.reduce((sum, c) => sum + c.count, 0);
  const requests = effect.leave?.length ?? 0;
  return `${days > 0 ? ` It changed how ${days} ${days === 1 ? 'day' : 'days'} that had already begun read, for ${effect.people} ${effect.people === 1 ? 'person' : 'people'}.` : ''}${requests > 0 ? ` ${requests} leave ${requests === 1 ? 'request includes' : 'requests include'} the date; the days charged for them were left as they were.` : ''}`;
}

export async function createHoliday(ctx: RequestContext, calendarId: string, raw: HolidayInput, confirmed: boolean): Promise<Holiday> {
  const calendar = await requireCalendar(calendarId);
  const input = soundHoliday(raw);
  if (await db().holidays.findOne({ calendarId, date: input.date }, { projection: { _id: 1 } })) throw unprocessable(DATE_TAKEN, { date: DATE_TAKEN });

  const now = clock.nowIso();
  const holiday: Holiday = { id: newId('hol'), calendarId, ...input, createdBy: ctx.employee.id, createdByName: ctx.employee.name, createdAt: now, updatedAt: now };
  const effect = await effectOf(calendarId, [input.date], (current) => [...current, holiday]);
  confirmPast(effect, confirmed);
  try {
    await db().holidays.insertOne(toDoc(holiday));
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(DATE_TAKEN, { date: DATE_TAKEN });
    throw error;
  }
  await recordAudit(ctx, { action: 'holiday.created', targetType: 'holiday', targetId: holiday.id, summary: `Added "${input.name}" on ${input.date} to the holiday calendar "${calendar.name}".${effectNote(effect)}`, after: { ...input, effect: hasEffect(effect) ? effect : undefined } });
  return holiday;
}

export async function updateHoliday(ctx: RequestContext, id: string, raw: HolidayInput, confirmed: boolean): Promise<Holiday> {
  const doc = await db().holidays.findOne({ _id: id });
  if (!doc) throw notFound('That holiday no longer exists.');
  const existing = fromDoc<Holiday>(doc);
  const calendar = await requireCalendar(existing.calendarId);
  const input = soundHoliday(raw);
  if (input.date !== existing.date && (await db().holidays.findOne({ calendarId: existing.calendarId, date: input.date }, { projection: { _id: 1 } }))) throw unprocessable(DATE_TAKEN, { date: DATE_TAKEN });

  const updated: Holiday = { ...existing, ...input, updatedAt: clock.nowIso() };
  const effect = await effectOf(existing.calendarId, [...new Set([existing.date, input.date])], (current) => [...current.filter((h) => h.id !== id), updated]);
  confirmPast(effect, confirmed);
  try {
    await db().holidays.updateOne({ _id: id }, { $set: { ...input, updatedAt: updated.updatedAt } });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(DATE_TAKEN, { date: DATE_TAKEN });
    throw error;
  }
  const was = { date: existing.date, name: existing.name, type: existing.type, description: existing.description };
  await recordAudit(ctx, { action: 'holiday.updated', targetType: 'holiday', targetId: id, summary: `Changed "${existing.name}" on ${existing.date} in the holiday calendar "${calendar.name}".${effectNote(effect)}`, before: was, after: { ...input, effect: hasEffect(effect) ? effect : undefined } });
  return updated;
}

export async function deleteHoliday(ctx: RequestContext, id: string, confirmed: boolean) {
  const doc = await db().holidays.findOne({ _id: id });
  if (!doc) throw notFound('That holiday no longer exists.');
  const existing = fromDoc<Holiday>(doc);
  const calendar = await requireCalendar(existing.calendarId);
  const effect = await effectOf(existing.calendarId, [existing.date], (current) => current.filter((h) => h.id !== id));
  confirmPast(effect, confirmed);
  await db().holidays.deleteOne({ _id: id });
  await recordAudit(ctx, {
    action: 'holiday.deleted',
    targetType: 'holiday',
    targetId: id,
    summary: `Removed "${existing.name}" on ${existing.date} from the holiday calendar "${calendar.name}".${effectNote(effect)}`,
    before: { date: existing.date, name: existing.name, type: existing.type, description: existing.description },
    after: hasEffect(effect) ? { effect } : undefined,
  });
}

/**
 * Copies one year's holidays into the next, date for date, for HR to review. A date that has
 * already begun is never written this way: it is left out and said so, to be added by hand,
 * where its effect is shown first.
 */
export async function copyCalendarYear(ctx: RequestContext, calendarId: string, fromYear: number): Promise<CopyYearResult> {
  const calendar = await requireCalendar(calendarId);
  const toYear = fromYear + 1;
  const [source, target, company] = await Promise.all([
    db().holidays.find({ calendarId, date: yearRange(fromYear) }).toArray(),
    db().holidays.find({ calendarId, date: yearRange(toYear) }, { projection: { date: 1 } }).toArray(),
    loadCompany(),
  ]);
  if (source.length === 0) throw unprocessable(`"${calendar.name}" has no holidays in ${fromYear} to copy.`);
  // Tomorrow in the company's zone may already be today for someone further east: it counts as begun.
  const begun = addDays(localDateOf(clock.now(), company.timeZone), 1);
  const plan = copyYear(source, toYear, new Set(target.map((h) => h.date)), begun);

  const now = clock.nowIso();
  const result: CopyYearResult = { toYear, copied: [], skipped: plan.skipped };
  for (const input of plan.copy) {
    const holiday: Holiday = { id: newId('hol'), calendarId, ...input, createdBy: ctx.employee.id, createdByName: ctx.employee.name, createdAt: now, updatedAt: now };
    try {
      await db().holidays.insertOne(toDoc(holiday));
      result.copied.push(holiday);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      result.skipped.push({ date: input.date, name: input.name, reason: 'That date already has a holiday.' });
    }
  }
  if (result.copied.length > 0) {
    await recordAudit(ctx, { action: 'holiday_calendar.year_copied', targetType: 'holiday_calendar', targetId: calendarId, summary: `Copied ${result.copied.length} ${result.copied.length === 1 ? 'holiday' : 'holidays'} of "${calendar.name}" from ${fromYear} to ${toYear}.`, after: { copied: result.copied.map((h) => ({ date: h.date, name: h.name })), skipped: result.skipped.length } });
  }
  return result;
}

/**
 * Puts one or many people on a holiday calendar (or on none) from a date. Each person is
 * judged on their own, and the answer says who was moved and, for everyone else, why not.
 *
 * The calendar is part of the schedule assignment, so this adds a new assignment from that
 * date with the same rules and the new calendar. Every earlier day keeps the calendar it had.
 */
export async function giveCalendar(ctx: RequestContext, input: CalendarAssignInput): Promise<AssignmentResult> {
  const calendar = input.calendarId ? await requireCalendar(input.calendarId) : null;
  const calendarInWords = calendar ? `the holiday calendar "${calendar.name}"` : 'no holiday calendar';

  const ids = [...new Set(input.employeeIds)];
  const [people, existing, everyone] = await Promise.all([db().employees.find({ _id: { $in: ids } }).toArray(), assignmentsOf(ids), loadOrg()]);
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
    const own = existing.get(id) ?? [];
    const { current, planned } = sortAssignments(own, now);
    const first = current ?? planned[0];
    if (!first) {
      skip('They have no work schedule yet. The holiday calendar is given with the schedule: give them one first.');
      continue;
    }
    const today = localDateOf(now, first.rules.timeZone);
    let changed = 0;
    if (current) {
      const blocked = calendarStartBlocker(input.effectiveFrom, today);
      if (blocked) {
        skip(blocked);
        continue;
      }
      const inForce = assignmentOn(own, input.effectiveFrom)!;
      // An assignment that starts on that very day has not begun: it is one of the planned ones changed below.
      if (inForce.effectiveFrom !== input.effectiveFrom && inForce.holidayCalendarId !== input.calendarId) {
        const assignment: ScheduleAssignment = { ...inForce, id: newId('asg'), effectiveFrom: input.effectiveFrom, holidayCalendarId: input.calendarId, note: `Holiday calendar: ${calendar?.name ?? 'none'}`, createdBy: ctx.employee.id, createdByName: ctx.employee.name, createdAt: now.toISOString() };
        try {
          await db().scheduleAssignments.insertOne(toDoc(assignment));
          changed += 1;
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          skip('Someone else changed their schedule from that date at the same moment. Check it and try again.');
          continue;
        }
      }
    }
    // Assignments from that date on have not started, so they are not history yet: they follow.
    const followers = await db().scheduleAssignments.updateMany({ employeeId: id, effectiveFrom: current ? { $gte: input.effectiveFrom, $gt: today } : { $gt: today }, holidayCalendarId: { $ne: input.calendarId } }, { $set: { holidayCalendarId: input.calendarId } });
    changed += followers.modifiedCount;
    if (changed === 0) {
      skip(`They are already on ${calendarInWords} from that date.`);
      continue;
    }
    const from = current ? input.effectiveFrom : first.effectiveFrom;
    result.assigned.push({ employeeId: id, name: person.name });
    audits.push({
      action: 'holiday_calendar.assigned',
      targetType: 'holiday_calendar',
      targetId: input.calendarId,
      employeeId: id,
      summary: `Put ${person.name} on ${calendarInWords} from ${from}.`,
      before: { holidayCalendarId: (current ? assignmentOn(own, input.effectiveFrom) : first)?.holidayCalendarId ?? null },
      after: { holidayCalendarId: input.calendarId, effectiveFrom: from },
      selfAdministered: id === ctx.employee.id && ownRecord === 'self_administered',
    });
  }
  await recordAudits(ctx, audits);
  // Leave already asked for from that date on was counted with the calendar they were on: say which requests those are.
  const touched = await leaveTouching(result.assigned.map((a) => a.employeeId), input.effectiveFrom, null);
  if (touched.length > 0) result.leave = touched;
  return result;
}

const toMine = ({ date, name, type, description }: Holiday): MyHoliday => ({ date, name, type, description });

/** The next few holidays for someone, from a date on, each from the calendar they will be on then. */
export function upcomingFor(person: PersonContext, from: LocalDate, limit: number): MyHoliday[] {
  return holidaysFor(person.assignments, person.holidays, from, addDays(from, 366)).slice(0, limit).map(toMine);
}

/** The signed-in person's holidays in a year. */
export async function myHolidays(employee: Account, year: number): Promise<MyHolidaysPayload> {
  const now = clock.now();
  const person = await contextFor(employee, now);
  const names = await calendarNames([person.calendarId]);
  const today = localDateOf(now, person.timeZone);
  return {
    year,
    today,
    next: upcomingFor(person, today, 1)[0] ?? null,
    calendarName: (person.calendarId && names.get(person.calendarId)) || null,
    holidays: holidaysFor(person.assignments, person.holidays, `${year}-01-01`, `${year}-12-31`).map(toMine),
  };
}
