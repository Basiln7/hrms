import {
  addDays,
  assignmentOn,
  closableUntil,
  composeToday,
  dayInWords,
  decideCheckIn,
  evaluateDay,
  formatMinutes,
  holidayLookup,
  leaveOnDate,
  leavePendingOn,
  localDateOf,
  localParts,
  monthOf,
  monthRange,
  summarize,
  type AttendanceCalendarPayload,
  type AttendanceRecord,
  type DayContext,
  type DayInput,
  type DayRecord,
  type DayResult,
  type Holiday,
  type LeaveSpan,
  type LocalDate,
  type LocalMonth,
  type ScheduleAssignment,
  type ScheduleRules,
  type TodayPayload,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { attendanceId, db, fromDoc, isDuplicateKey, type Account, type AttendanceDayDoc, type StoredHistoryEntry } from '../db';
import type { RequestContext } from '../http/context';
import { conflict, notFound } from '../http/errors';
import { assertInScope } from './access';
import { leaveSpansOf } from './leaveStore';
import { assignmentsOf, sortAssignments } from './schedules';
import { loadCompany } from './settings';

/*
 * Check-in, check-out and breaks.
 *
 * Three things hold for every punch:
 * - The time is the server's. No route here takes a time, a date or a duration from the
 *   request; the only input is who is signed in.
 * - Each punch is one conditional write to that person's one document for that day, so a
 *   second check-in, or two sent at the same instant, cannot both be stored.
 * - Only facts are written. How the day reads (present, late, half-day) is worked out by the
 *   shared engine whenever it is asked for, from those facts and the rules the day was punched under.
 */

/** Everything the engine needs to read one person's days. */
export interface PersonContext {
  ctx: DayContext;
  assignments: ScheduleAssignment[];
  /** Every holiday on the calendars those assignments name. Which one applies on a date is the engine's lookup. */
  holidays: Holiday[];
  /** The zone of the rules they work under now, or the company's when they have none. */
  timeZone: string;
  /** The rules in force for them today. */
  rules: ScheduleRules | null;
  /** The holiday calendar they are on now, or will be on when their first schedule starts. */
  calendarId: string | null;
  /** The days that have a correction request waiting for a decision. */
  pendingDates: ReadonlySet<LocalDate>;
  /** Their leave requests that are approved or still waiting. What they mean for a date is the shared `leaveOnDate`. */
  leave: readonly LeaveSpan[];
}

/**
 * One person's context from facts already fetched. Kept apart from the fetching so that many
 * people can be read with a handful of queries, and so that "what if this holiday changed"
 * can be asked by passing a different list of holidays.
 */
export function buildContext(employee: Pick<Account, 'id' | 'employment'>, assignments: ScheduleAssignment[], holidays: Holiday[], companyZone: string, now: Date, pendingDates: ReadonlySet<LocalDate> = new Set(), leave: readonly LeaveSpan[] = []): PersonContext {
  const { current, planned } = sortAssignments(assignments, now);
  const ctx: DayContext = {
    rulesOn: (date) => assignmentOn(assignments, date)?.rules ?? null,
    // The holiday on a date comes from the calendar named by the assignment in force on that date.
    holidayOn: holidayLookup(assignments, holidays),
    employment: employee.employment,
  };
  return { ctx, assignments, holidays, timeZone: current?.rules.timeZone ?? companyZone, rules: current?.rules ?? null, calendarId: (current ?? planned[0])?.holidayCalendarId ?? null, pendingDates, leave };
}

/** Every holiday on the calendars some assignments name. */
export async function holidaysNamedBy(assignments: readonly ScheduleAssignment[]): Promise<Holiday[]> {
  const calendarIds = [...new Set(assignments.map((a) => a.holidayCalendarId).filter((id): id is string => id !== null))];
  if (calendarIds.length === 0) return [];
  return (await db().holidays.find({ calendarId: { $in: calendarIds } }).toArray()).map((doc) => fromDoc<Holiday>(doc));
}

export async function contextFor(employee: Pick<Account, 'id' | 'employment'>, now: Date): Promise<PersonContext> {
  const assignments = (await assignmentsOf([employee.id])).get(employee.id) ?? [];
  const [holidays, company, pending, leave] = await Promise.all([
    holidaysNamedBy(assignments),
    loadCompany(),
    db().corrections.find({ employeeId: employee.id, status: 'pending' }, { projection: { date: 1 } }).toArray(),
    leaveSpansOf([employee.id]),
  ]);
  return buildContext(employee, assignments, holidays, company.timeZone, now, new Set(pending.map((request) => request.date)), leave.get(employee.id) ?? []);
}

/**
 * The same for many people at once, with a fixed handful of queries whatever their number:
 * one each for their schedules, the holidays on the calendars those name, the corrections
 * that are waiting, and their leave. `range` narrows the last two to the dates being read.
 */
export async function contextsFor(employees: readonly Pick<Account, 'id' | 'employment'>[], now: Date, range?: { from: LocalDate; to: LocalDate }): Promise<Map<string, PersonContext>> {
  const ids = employees.map((employee) => employee.id);
  const [assignments, company, pending, leave] = await Promise.all([
    assignmentsOf(ids),
    loadCompany(),
    ids.length === 0
      ? []
      : db()
          .corrections.find({ employeeId: { $in: ids }, status: 'pending', ...(range ? { date: { $gte: range.from, $lte: range.to } } : {}) }, { projection: { employeeId: 1, date: 1 } })
          .toArray(),
    leaveSpansOf(ids, range),
  ]);
  const holidays = await holidaysNamedBy([...assignments.values()].flat());
  const waiting = new Map<string, Set<LocalDate>>();
  for (const request of pending) {
    const dates = waiting.get(request.employeeId) ?? new Set<LocalDate>();
    dates.add(request.date);
    waiting.set(request.employeeId, dates);
  }
  return new Map(employees.map((employee) => [employee.id, buildContext(employee, assignments.get(employee.id) ?? [], holidays, company.timeZone, now, waiting.get(employee.id), leave.get(employee.id))]));
}

/** The rules a day document was punched under: its own assignment's, whatever has been assigned since. */
export const rulesOf = (doc: AttendanceDayDoc, person: PersonContext): ScheduleRules | null => person.assignments.find((a) => a.id === doc.assignmentId)?.rules ?? person.ctx.rulesOn(doc.date);

/** What is known about a date apart from its punches: a correction waiting, approved leave, a leave request waiting. */
export const extrasFor = (person: PersonContext, date: LocalDate): Pick<DayInput, 'pendingCorrection' | 'leave' | 'pendingLeave'> => ({
  pendingCorrection: person.pendingDates.has(date),
  leave: leaveOnDate(person.leave, date),
  pendingLeave: leavePendingOn(person.leave, date),
});

export function inputFor(doc: AttendanceDayDoc | null, person: PersonContext, date: LocalDate | undefined = doc?.date): DayInput {
  const rules = doc ? rulesOf(doc, person) : null;
  const extras = date === undefined ? {} : extrasFor(person, date);
  if (!doc || !rules) return { record: null, ...extras };
  return {
    ...extras,
    record: {
      rules,
      checkInAt: doc.checkInAt,
      checkOutAt: doc.checkOutAt,
      breaks: doc.breaks,
      override: doc.override,
      lateExcused: doc.lateExcused,
      corrected: doc.history.some((h) => h.kind === 'corrected'),
    },
  };
}

/** The day that is checked in and not yet checked out, if there is one. There is at most one that matters: the latest. */
const openDayOf = (employeeId: string) => db().attendanceDays.find({ employeeId, checkInAt: { $ne: null }, checkOutAt: null }).sort({ date: -1 }).limit(1).next();

/** The open day, when it can still be checked out at this moment. */
async function closableDay(employeeId: string, person: PersonContext, now: Date) {
  const doc = await openDayOf(employeeId);
  const rules = doc ? rulesOf(doc, person) : null;
  if (!doc || !rules) return null;
  const until = closableUntil(doc.date, doc.checkInAt!, rules, person.ctx);
  return now.getTime() < until.getTime() ? { doc, rules, until } : null;
}

const clockOn = (moment: string | Date, zone: string) => localParts(moment, zone).time;

/** "today", or the day in words: "Monday 7 December". */
const dayName = (date: LocalDate, today: LocalDate) => (date === today ? 'today' : dayInWords(date));

/** A day document as the shared code reads it: its facts, with the rules it was punched under. */
function recordOf(doc: AttendanceDayDoc | null, person: PersonContext): DayRecord | null {
  const record = inputFor(doc, person).record;
  return doc && record ? { ...record, date: doc.date } : null;
}

/**
 * What the home page shows for today, and which buttons it may offer. The deciding is
 * `composeToday` in shared; this only fetches what it needs: the open day, and what is
 * recorded for yesterday, today and tomorrow (the only days a check-in made now can belong to).
 */
export async function todayFor(employee: Account, at?: { now: Date; person: PersonContext }): Promise<TodayPayload> {
  const now = at?.now ?? clock.now();
  const person = at?.person ?? (await contextFor(employee, now));
  const today = localDateOf(now, person.timeZone);
  const [open, nearby] = await Promise.all([
    openDayOf(employee.id),
    db()
      .attendanceDays.find({ _id: { $in: [addDays(today, -1), today, addDays(today, 1)].map((date) => attendanceId(employee.id, date)) } })
      .toArray(),
  ]);
  const records = nearby.map((doc) => recordOf(doc, person)).filter((record): record is DayRecord => record !== null);
  return composeToday(now, { timeZone: person.timeZone, rules: person.rules, ctx: person.ctx }, recordOf(open, person), records, (date) => extrasFor(person, date));
}

/**
 * How each day from one date to another reads for someone, in order. One query for the facts,
 * then the engine once per date: the home page's month, the calendar and the reports all come
 * from here, so they cannot disagree.
 */
export async function daysIn(employeeId: string, person: PersonContext, from: LocalDate, to: LocalDate, now: Date): Promise<DayResult[]> {
  const docs = await db()
    .attendanceDays.find({ employeeId, date: { $gte: from, $lte: to } })
    .toArray();
  const byDate = new Map(docs.map((doc) => [doc.date, doc]));
  const days: DayResult[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) days.push(evaluateDay(date, now, person.ctx, inputFor(byDate.get(date) ?? null, person, date)));
  return days;
}

const entry = (ctx: RequestContext, kind: StoredHistoryEntry['kind'], at: string, after: unknown, userAgent: string | undefined): StoredHistoryEntry => ({
  at,
  by: ctx.employee.id,
  byName: ctx.employee.name,
  kind,
  after,
  ip: ctx.ip || undefined,
  userAgent: userAgent?.slice(0, 300) || undefined,
});

/**
 * Checks the signed-in person in, now. Which day it belongs to is the engine's decision (a
 * night shift at 00:30 is still yesterday's). The write goes through only when that day has
 * no check-in yet: an existing one, or another arriving at the same instant, is refused.
 */
export async function checkIn(ctx: RequestContext, userAgent?: string): Promise<TodayPayload> {
  const now = clock.now();
  const person = await contextFor(ctx.employee, now);
  const today = localDateOf(now, person.timeZone);
  const open = await closableDay(ctx.employee.id, person, now);
  if (open) throw conflict(`You are still checked in since ${clockOn(open.doc.checkInAt!, person.timeZone)} ${open.doc.date === today ? 'today' : `on ${dayInWords(open.doc.date)}`}. Check out first.`);

  const decision = decideCheckIn(now, person.timeZone, person.ctx);
  if (!decision.allowed) throw conflict(decision.reason);
  const assignment = assignmentOn(person.assignments, decision.date);
  if (!assignment) throw conflict('You have no work schedule yet, so you cannot check in. Ask HR to give you one.');

  const at = now.toISOString();
  const already = `You have already checked in for ${dayName(decision.date, today)}. If that was a mistake, it can be put right with a correction.`;
  try {
    // `checkInAt: null` matches a document with no check-in, or no document at all (then it is created).
    // A document that has one does not match, the insert collides with it, and the punch is refused.
    await db().attendanceDays.updateOne(
      { _id: attendanceId(ctx.employee.id, decision.date), checkInAt: null },
      {
        $set: { checkInAt: at, assignmentId: assignment.id, updatedAt: at },
        $setOnInsert: { employeeId: ctx.employee.id, date: decision.date, checkOutAt: null, breaks: [], override: null, lateExcused: false, note: null, createdAt: at },
        $push: { history: entry(ctx, 'check_in', at, { checkInAt: at }, userAgent) },
        $inc: { version: 1 },
      },
      { upsert: true },
    );
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(already);
    throw error;
  }
  return todayFor(ctx.employee);
}

const NOT_CHECKED_IN = 'You are not checked in.';
const ALREADY_CHECKED_OUT = 'You have already checked out. If that was a mistake, it can be put right with a correction.';

/** The open day of the signed-in person, or a refusal that says why there is nothing to act on. */
async function requireOpenDay(ctx: RequestContext, now: Date) {
  const person = await contextFor(ctx.employee, now);
  const open = await closableDay(ctx.employee.id, person, now);
  if (open) return { ...open, person };
  const stale = await openDayOf(ctx.employee.id);
  const rules = stale ? rulesOf(stale, person) : null;
  if (stale && rules) {
    throw conflict(`Your check-in on ${dayInWords(stale.date)} can no longer be checked out: a day can be closed for ${formatMinutes(rules.missingCheckOut.closeAfterMinutes)} at most, and not after the next working day has opened. Ask for a correction of the missing check-out.`);
  }
  // Nothing is open. If the day a check-in would belong to is already closed, say that rather than "not checked in".
  const decision = decideCheckIn(now, person.timeZone, person.ctx);
  const date = decision.allowed ? decision.date : localDateOf(now, person.timeZone);
  const done = await db().attendanceDays.findOne({ _id: attendanceId(ctx.employee.id, date) }, { projection: { checkOutAt: 1 } });
  throw conflict(done?.checkOutAt ? ALREADY_CHECKED_OUT : NOT_CHECKED_IN);
}

/** Checks the signed-in person out of their open day, now. A break still running ends with it. */
export async function checkOut(ctx: RequestContext, userAgent?: string): Promise<TodayPayload> {
  const now = clock.now();
  const { doc } = await requireOpenDay(ctx, now);
  const at = now.toISOString();
  const result = await db().attendanceDays.updateOne(
    { _id: doc._id, checkInAt: { $ne: null }, checkOutAt: null },
    { $set: { checkOutAt: at, updatedAt: at, 'breaks.$[running].endAt': at }, $push: { history: entry(ctx, 'check_out', at, { checkOutAt: at }, userAgent) }, $inc: { version: 1 } },
    { arrayFilters: [{ 'running.endAt': null }] },
  );
  if (result.modifiedCount === 0) throw conflict(ALREADY_CHECKED_OUT);
  return todayFor(ctx.employee);
}

/** Starts a break, on schedules where breaks are recorded. */
export async function startBreak(ctx: RequestContext, userAgent?: string): Promise<TodayPayload> {
  const now = clock.now();
  const { doc, rules } = await requireOpenDay(ctx, now);
  if (rules.break.mode !== 'tracked') throw conflict('Breaks are not recorded on your schedule, so there is nothing to start.');
  const at = now.toISOString();
  const result = await db().attendanceDays.updateOne(
    { _id: doc._id, checkOutAt: null, breaks: { $not: { $elemMatch: { endAt: null } } } },
    { $set: { updatedAt: at }, $push: { breaks: { startAt: at, endAt: null }, history: entry(ctx, 'break_start', at, { startAt: at }, userAgent) }, $inc: { version: 1 } },
  );
  if (result.modifiedCount === 0) throw conflict('You are already on a break.');
  return todayFor(ctx.employee);
}

export async function endBreak(ctx: RequestContext, userAgent?: string): Promise<TodayPayload> {
  const now = clock.now();
  const { doc } = await requireOpenDay(ctx, now);
  const at = now.toISOString();
  const result = await db().attendanceDays.updateOne(
    { _id: doc._id, checkOutAt: null, breaks: { $elemMatch: { endAt: null } } },
    { $set: { updatedAt: at, 'breaks.$[running].endAt': at }, $push: { history: entry(ctx, 'break_end', at, { endAt: at }, userAgent) }, $inc: { version: 1 } },
    { arrayFilters: [{ 'running.endAt': null }] },
  );
  if (result.modifiedCount === 0) throw conflict('You are not on a break.');
  return todayFor(ctx.employee);
}

/** A day as the API returns it: the facts and their history, without where each request came from. */
export function toRecord(doc: AttendanceDayDoc): AttendanceRecord {
  return {
    employeeId: doc.employeeId,
    date: doc.date,
    checkInAt: doc.checkInAt,
    checkOutAt: doc.checkOutAt,
    breaks: doc.breaks,
    override: doc.override,
    lateExcused: doc.lateExcused,
    note: doc.note ? { text: doc.note.text, byName: doc.note.byName, at: doc.note.at } : null,
    history: doc.history.map(({ ip: _ip, userAgent: _userAgent, ...rest }) => rest),
    version: doc.version,
  };
}

/**
 * One person's month, read now: every date as the engine reads it, and the month added up.
 * Their own, or anyone the caller may see; for anyone else the answer is "not found". With no
 * month named it is the month today falls in for that person.
 */
export async function monthCalendar(ctx: RequestContext, employeeId: string, asked: LocalMonth | undefined): Promise<AttendanceCalendarPayload> {
  await assertInScope(ctx, employeeId);
  const target = employeeId === ctx.employee.id ? ctx.employee : await db().employees.findOne({ _id: employeeId }).then((doc) => (doc ? fromDoc<Account>(doc) : null));
  if (!target) throw notFound('That person does not exist.');
  const now = clock.now();
  const person = await contextFor(target, now);
  const today = localDateOf(now, person.timeZone);
  const month = asked ?? monthOf(today);
  const { from, to } = monthRange(month);
  const days = await daysIn(employeeId, person, from, to, now);
  return { employee: { id: target.id, code: target.code, name: target.name }, month, today, timeZone: person.timeZone, days, summary: summarize(days) };
}
