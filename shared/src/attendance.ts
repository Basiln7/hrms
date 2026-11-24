/*
 * The attendance engine (plan.md, section 6).
 *
 * Only facts are stored: when someone checked in, when they checked out, their breaks, and any
 * approved correction. Everything else (present, late, half-day, absent, the month's totals) is
 * worked out here, whenever it is asked for, from those facts and the rules the person works
 * under. So a status can never go stale, and the web app and the API can never disagree.
 *
 * Nothing in this file reads a clock or a database. The time is always passed in, and what the
 * engine needs to know about a person's other days comes through `DayContext`.
 */
import { addDays, localDateOf, localParts, MINUTE, startOfDay, truncateToMinute, WEEKDAY_NAMES, weekdayOf, zonedToInstant, type Instant, type LocalDate } from './dates';
import type { EmploymentPeriod } from './org';
import { isEmployedOn } from './people';
import { breakDeducted, hoursFor, isOvernight, type BreakRule, type DayHours, type ScheduleRules } from './schedules';

export type HolidayType = 'public' | 'company' | 'optional' | 'special_working_day';

/** A holiday as the engine sees it on one date. Holiday calendars arrive in Phase 5. */
export interface HolidayOnDay {
  name: string;
  type: HolidayType;
}

export type LeavePart = 'full' | 'first_half' | 'second_half';

/** Approved leave on one date (see leave.ts for how requests become this). */
export interface LeaveOnDay {
  units: 0.5 | 1;
  part: LeavePart;
  /** The kind of leave, in words: "Casual leave". */
  name?: string;
  /** How much of it is unpaid leave. Left out when none of it is. */
  unpaidUnits?: number;
}

export interface AttendanceBreak {
  startAt: string;
  /** Null while the break is still running. */
  endAt: string | null;
}

/** What was recorded for a day. Facts only: nothing here is a judgement. */
export interface DayFacts {
  checkInAt: string | null;
  checkOutAt: string | null;
  breaks: readonly AttendanceBreak[];
  /** A status set by an approved correction (Phase 6). */
  override: 'present' | 'half_day' | null;
  /** The late entry was explained and accepted (Phase 6). The day stays late. */
  lateExcused: boolean;
  /** The times were changed by a correction (Phase 6). */
  corrected?: boolean;
}

/** What the engine may ask about a person's other days. */
export interface DayContext {
  /** The rules in force for them on a date, or null before their first schedule starts. */
  rulesOn: (date: LocalDate) => ScheduleRules | null;
  /** The holiday on a date, on the calendar that applies to them then. */
  holidayOn: (date: LocalDate) => HolidayOnDay | null;
  /** The periods attendance counts for. */
  employment: readonly EmploymentPeriod[];
}

export type DayKind = 'working' | 'weekly_off' | 'holiday';

/**
 * How a day reads. Exactly one applies; the flags say the rest.
 * - `not_applicable`: outside their employment, or before their first schedule.
 * - `upcoming`, `not_due`, `not_in`: a working day with no check-in: in the future; today, before
 *   they are late; today, after that but with the shift still running.
 * - `working`, `on_break`: checked in, and the day can still be closed.
 * - `unresolved`: checked in and never checked out, with nothing decided about it yet.
 */
export type DayStatus = 'not_applicable' | 'upcoming' | 'not_due' | 'not_in' | 'working' | 'on_break' | 'present' | 'half_day' | 'absent' | 'leave' | 'holiday' | 'weekly_off' | 'unresolved';

export type DayFlag = 'late' | 'late_excused' | 'early_departure' | 'short_hours' | 'worked_on_off_day' | 'worked_on_leave' | 'half_day_leave' | 'missing_check_out' | 'corrected' | 'pending_correction' | 'pending_leave';

/** How a working day that is over is accounted for. The four always add up to 1. */
export interface DayUnits {
  worked: number;
  leave: number;
  absent: number;
  unresolved: number;
}

export interface DayResult {
  date: LocalDate;
  /** Null when the day does not apply to them at all. */
  kind: DayKind | null;
  status: DayStatus;
  flags: DayFlag[];
  /** Set once a working day can be counted: it is over, or its punch is closed. */
  units: DayUnits | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  /** While they are on a break: when it started. */
  onBreakSince: string | null;
  /** Check-in to check-out, or to now while the day is open, in whole minutes. */
  grossMinutes: number;
  /** Break time taken off the gross. */
  breakMinutes: number;
  workedMinutes: number;
  /** Minutes after the start time, when late. Otherwise 0. */
  lateMinutes: number;
  /** Minutes before the end time, when leaving early is marked. Otherwise 0. */
  earlyMinutes: number;
  /** A fixed working day's start and end, as moments. */
  shiftStartAt: string | null;
  shiftEndAt: string | null;
  /** The hours expected that day, when it is a working day. */
  requiredMinutes: number | null;
  /** Until when a day that is still open can be checked out. */
  closableUntil: string | null;
  holiday: HolidayOnDay | null;
  /** Approved leave on the day, when it is a working day. */
  leave: LeaveOnDay | null;
}

const ms = (instant: Instant) => (instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant));
const iso = (moment: Date | null) => (moment ? moment.toISOString() : null);

/** What kind of day a date is for someone, and the rules and hours that go with it. */
export interface DayShape {
  kind: DayKind;
  rules: ScheduleRules;
  /** The hours of a working day. Null on a day off. */
  hours: DayHours | null;
  holiday: HolidayOnDay | null;
}

/**
 * The kind of day a date is for someone, or null when it does not apply to them (outside their
 * employment, or before their first schedule). A special working day beats a holiday; a holiday
 * beats the weekly pattern; an optional holiday is shown but is a working day.
 *
 * `own` is the rules a punch on that day was made under: a day with a punch is always read
 * with the rules it belongs to.
 */
export function shapeOf(date: LocalDate, ctx: DayContext, own?: ScheduleRules | null): DayShape | null {
  const rules = own ?? ctx.rulesOn(date);
  if (!rules || !isEmployedOn(ctx.employment, date)) return null;
  const holiday = ctx.holidayOn(date);
  const pattern = hoursFor(rules, weekdayOf(date));
  // A weekly off that is worked has no hours of its own: it takes the normal day's.
  if (holiday?.type === 'special_working_day') return { kind: 'working', rules, hours: pattern ?? rules.standard, holiday };
  if (holiday && holiday.type !== 'optional') return { kind: 'holiday', rules, hours: null, holiday };
  if (!pattern) return { kind: 'weekly_off', rules, hours: null, holiday };
  return { kind: 'working', rules, hours: pattern, holiday };
}

/** The start and end of a fixed working day, as moments on the wall clock of its time zone. */
function shiftOf(date: LocalDate, shape: DayShape): { startAt: Date; endAt: Date } | null {
  const hours = shape.hours;
  if (shape.kind !== 'working' || !hours?.start || !hours.end) return null;
  const zone = shape.rules.timeZone;
  return { startAt: zonedToInstant(date, hours.start, zone), endAt: zonedToInstant(isOvernight(hours) ? addDays(date, 1) : date, hours.end, zone) };
}

/** When check-in opens for a working day: before the start time for fixed hours, at local midnight for flexible. */
function opensAt(date: LocalDate, shape: DayShape): Date {
  const shift = shiftOf(date, shape);
  return shift ? new Date(shift.startAt.getTime() - shape.rules.earlyCheckInMinutes * MINUTE) : startOfDay(date, shape.rules.timeZone);
}

/** How far ahead the engine looks for someone's next working day. */
const LOOK_AHEAD_DAYS = 21;

/** When check-in opens for someone's next working day after a date, with the date it is for. */
export function nextOpening(after: LocalDate, ctx: DayContext): { date: LocalDate; opensAt: Date } | null {
  for (let i = 1; i <= LOOK_AHEAD_DAYS; i += 1) {
    const date = addDays(after, i);
    const shape = shapeOf(date, ctx);
    if (shape?.kind === 'working') return { date, opensAt: opensAt(date, shape) };
  }
  return null;
}

/**
 * The window in which a check-in belongs to a working day (plan.md, 6.4).
 *
 * Fixed hours: it opens `earlyCheckInMinutes` before the start, and closes `closeAfterMinutes`
 * after the start or when the next working day's window opens, whichever comes first.
 * Flexible hours: it is the local calendar day.
 */
export function windowOf(date: LocalDate, ctx: DayContext): { opensAt: Date; closesAt: Date } | null {
  const shape = shapeOf(date, ctx);
  if (shape?.kind !== 'working') return null;
  const shift = shiftOf(date, shape);
  if (!shift) return { opensAt: startOfDay(date, shape.rules.timeZone), closesAt: startOfDay(addDays(date, 1), shape.rules.timeZone) };
  const limit = shift.startAt.getTime() + shape.rules.missingCheckOut.closeAfterMinutes * MINUTE;
  const next = nextOpening(date, ctx);
  return { opensAt: opensAt(date, shape), closesAt: new Date(next ? Math.min(limit, next.opensAt.getTime()) : limit) };
}

/**
 * Until when a day that was checked in can still be checked out: `closeAfterMinutes` after the
 * check-in, or the opening of the next working day's window, whichever comes first. A flexible
 * day ends at its local midnight. After this the check-out is missing and needs a correction.
 */
export function closableUntil(date: LocalDate, checkInAt: Instant, rules: ScheduleRules, ctx: DayContext): Date {
  const limit = truncateToMinute(checkInAt).getTime() + rules.missingCheckOut.closeAfterMinutes * MINUTE;
  const bound = rules.kind === 'flexible' ? startOfDay(addDays(date, 1), rules.timeZone).getTime() : nextOpening(date, ctx)?.opensAt.getTime();
  return new Date(bound !== undefined && bound < limit ? bound : limit);
}

export type CheckInDecision = { allowed: true; date: LocalDate; offDay: boolean } | { allowed: false; reason: string };

const clockIn = (moment: Date, zone: string) => localParts(moment, zone).time;

/**
 * Which day a check-in made now belongs to, or why it cannot be made (plan.md, 6.4). A punch
 * belongs to a shift, not to whatever the calendar date happens to be: at 00:30 it may still be
 * yesterday's night shift, and at 23:55 it may already be tomorrow's.
 *
 * `timeZone` is the zone of the rules the person works under now. Whether that day already has
 * a check-in is for the caller to decide: the engine only says which day it would be.
 */
export function decideCheckIn(now: Instant, timeZone: string, ctx: DayContext): CheckInDecision {
  const at = ms(now);
  const today = localDateOf(at, timeZone);
  for (const date of [addDays(today, -1), today, addDays(today, 1)]) {
    const window = windowOf(date, ctx);
    if (window && window.opensAt.getTime() <= at && at < window.closesAt.getTime()) return { allowed: true, date, offDay: false };
  }

  const shape = shapeOf(today, ctx);
  if (!shape) {
    return { allowed: false, reason: ctx.rulesOn(today) ? 'Attendance is not being counted for you today. Ask HR if that is wrong.' : 'You have no work schedule yet, so you cannot check in. Ask HR to give you one.' };
  }
  if (shape.kind !== 'working') {
    if (shape.rules.offDayWork === 'allowed') return { allowed: true, date: today, offDay: true };
    return { allowed: false, reason: shape.kind === 'holiday' ? `Today is a holiday (${shape.holiday?.name ?? 'holiday'}), and your schedule does not allow checking in on a day off.` : 'Today is your weekly off, and your schedule does not allow checking in on a day off.' };
  }
  // A working day, but outside its window: too early, or so late that the day has closed.
  const opening = opensAt(today, shape);
  if (at < opening.getTime()) return { allowed: false, reason: `Check-in for today opens at ${clockIn(opening, timeZone)}.` };
  const next = nextOpening(today, ctx);
  if (!next) return { allowed: false, reason: 'Check-in for today has closed.' };
  // The next opening may be later today (a shift that starts at midnight opens the evening before).
  const opensOn = localDateOf(next.opensAt, timeZone);
  return { allowed: false, reason: `Check-in for today has closed. It opens again at ${clockIn(next.opensAt, timeZone)}${opensOn === today ? '' : ` on ${WEEKDAY_NAMES[weekdayOf(opensOn)]}`}.` };
}

/** Break time actually recorded between two moments, in whole minutes. A break still running ends at `outAt`. */
function breakTaken(breaks: readonly AttendanceBreak[], inAt: Date, outAt: Date): number {
  let total = 0;
  for (const b of breaks) {
    const from = Math.max(truncateToMinute(b.startAt).getTime(), inAt.getTime());
    const to = Math.min(b.endAt ? truncateToMinute(b.endAt).getTime() : outAt.getTime(), outAt.getTime());
    if (to > from) total += (to - from) / MINUTE;
  }
  return total;
}

/**
 * A day's minutes from its check-in to a moment (the check-out, or now while it is open): the
 * gross time, the break taken off it, and what is left as worked (plan.md, 6.3). Both moments
 * are cut to the minute first. The engine and the live timer on the home page both count with
 * this, so the screen cannot disagree with what is recorded.
 */
export function countMinutes(checkInAt: Instant, until: Instant, breaks: readonly AttendanceBreak[], rule: BreakRule): { gross: number; break: number; worked: number } {
  const inAt = truncateToMinute(checkInAt);
  const outAt = truncateToMinute(until);
  const gross = Math.max(0, (outAt.getTime() - inAt.getTime()) / MINUTE);
  const taken = breakDeducted(rule, gross, breakTaken(breaks, inAt, outAt));
  return { gross, break: taken, worked: gross - taken };
}

/** The work a day's hours make of some worked time, out of what is owed that day (1, or ½ with half-day leave). */
export function workUnits(hours: DayHours, worked: number, owed: number): number {
  if (owed <= 0) return 0;
  if (owed >= 1 && worked >= hours.fullDayMinutes) return 1;
  return worked >= hours.halfDayMinutes ? 0.5 : 0;
}

const units = (worked: number, leave: number, unresolved = 0): DayUnits => ({ worked, leave, absent: Math.max(0, 1 - worked - leave - unresolved), unresolved });

export interface DayInput {
  /** The day's facts, with the rules they were punched under. Null when nothing was recorded. */
  record: (DayFacts & { rules: ScheduleRules }) | null;
  /** Approved leave on the day. */
  leave?: LeaveOnDay | null;
  /** A correction request is waiting to be decided. */
  pendingCorrection?: boolean;
  /** A leave request that includes the day is waiting to be decided. Until it is approved the day reads as it would without it. */
  pendingLeave?: boolean;
}

/**
 * How one calendar day reads for one person at a moment (plan.md, 6.3 and 6.5).
 *
 * The same function answers for a day with a punch and a day without one, for today and for
 * last year, for the employee's home page and for HR's report. It is the only place a status
 * is ever decided.
 */
export function evaluateDay(date: LocalDate, now: Instant, ctx: DayContext, input: DayInput = { record: null }): DayResult {
  const at = ms(now);
  // A day document can exist without a punch (HR left a note on it): that is not a check-in.
  const record = input.record?.checkInAt ? input.record : null;
  // A status set by an approved correction counts with or without a punch.
  const override = input.record?.override ?? null;
  const result: DayResult = {
    date,
    kind: null,
    status: 'not_applicable',
    flags: [],
    units: null,
    checkInAt: record?.checkInAt ?? null,
    checkOutAt: record?.checkOutAt ?? null,
    onBreakSince: null,
    grossMinutes: 0,
    breakMinutes: 0,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyMinutes: 0,
    shiftStartAt: null,
    shiftEndAt: null,
    requiredMinutes: null,
    closableUntil: null,
    holiday: null,
    leave: null,
  };
  const shape = shapeOf(date, ctx, record?.rules);
  if (!shape) return result;

  const { rules, hours } = shape;
  const zone = rules.timeZone;
  const shift = shiftOf(date, shape);
  const working = shape.kind === 'working';
  const leave = working ? (input.leave ?? null) : null;
  const leaveUnits = leave?.units ?? 0;
  const flags = new Set<DayFlag>();
  result.kind = shape.kind;
  result.holiday = shape.holiday;
  result.leave = leave;
  if (working && input.pendingLeave) flags.add('pending_leave');
  result.shiftStartAt = iso(shift?.startAt ?? null);
  result.shiftEndAt = iso(shift?.endAt ?? null);
  result.requiredMinutes = working && hours ? hours.requiredMinutes : null;
  if (input.pendingCorrection) flags.add('pending_correction');
  if (leaveUnits === 0.5) flags.add('half_day_leave');

  // A fixed working day is over at the end of its shift; any other day at its local midnight.
  const overAt = (shift?.endAt ?? startOfDay(addDays(date, 1), zone)).getTime();
  const over = at >= overAt;

  let closed = false;
  let stillOpen = false;
  if (record) {
    const inAt = truncateToMinute(record.checkInAt!);
    closed = record.checkOutAt !== null;
    const until = closed ? null : closableUntil(date, inAt, rules, ctx);
    stillOpen = until !== null && at < until.getTime();
    result.closableUntil = stillOpen ? iso(until) : null;
    // A day that was never closed and no longer can be has no known length: nothing is counted for it.
    const outAt = closed ? record.checkOutAt! : stillOpen ? at : null;
    if (outAt !== null) {
      const counted = countMinutes(inAt, outAt, record.breaks, rules.break);
      result.grossMinutes = counted.gross;
      result.breakMinutes = counted.break;
      result.workedMinutes = counted.worked;
    }
    if (stillOpen) result.onBreakSince = [...record.breaks].reverse().find((b) => b.endAt === null)?.startAt ?? null;
    if (!closed && !stillOpen) flags.add('missing_check_out');
    if (record.corrected) flags.add('corrected');
    if (!working) flags.add('worked_on_off_day');

    if (working && shift) {
      // Leave over the first half of the day moves when they are expected: lateness is not judged.
      const late = (inAt.getTime() - shift.startAt.getTime()) / MINUTE;
      if (late > rules.lateGraceMinutes && leave?.part !== 'first_half' && leaveUnits < 1) {
        flags.add('late');
        result.lateMinutes = late;
        if (record.lateExcused) flags.add('late_excused');
      }
      const early = closed ? (shift.endAt.getTime() - truncateToMinute(record.checkOutAt!).getTime()) / MINUTE : 0;
      if (rules.earlyLeave.tracked && early > rules.earlyLeave.graceMinutes && leave?.part !== 'second_half' && leaveUnits < 1) {
        flags.add('early_departure');
        result.earlyMinutes = early;
      }
    }
    if (working && closed && hours && leaveUnits === 0 && result.workedMinutes < hours.requiredMinutes) flags.add('short_hours');
  }

  if (!working) {
    // A day off stays a day off. A punch on it shows the hours and nothing more.
    result.status = stillOpen ? (result.onBreakSince ? 'on_break' : 'working') : shape.kind;
  } else if (leaveUnits === 1) {
    result.status = 'leave';
    if (record) flags.add('worked_on_leave');
    if (over || record) result.units = units(0, 1);
  } else if (record && stillOpen) {
    result.status = result.onBreakSince ? 'on_break' : 'working';
  } else if (record) {
    const owed = 1 - leaveUnits;
    let worked: number;
    let unresolved = 0;
    if (record.override) worked = Math.min(record.override === 'present' ? 1 : 0.5, owed);
    else if (closed) worked = workUnits(hours!, result.workedMinutes, owed);
    else if (rules.missingCheckOut.countsAs === 'half_day') worked = Math.min(0.5, owed);
    else {
      worked = 0;
      if (rules.missingCheckOut.countsAs === 'unresolved') unresolved = owed;
    }
    if (record.override) flags.add('corrected');
    result.units = units(worked, leaveUnits, unresolved);
    result.status = unresolved > 0 ? 'unresolved' : worked >= 1 ? 'present' : worked > 0 ? 'half_day' : 'absent';
  } else if (override) {
    // Nothing was punched, and an approved correction says how the day counts all the same
    // (someone who worked away from the office, say). It is marked as corrected.
    const worked = Math.min(override === 'present' ? 1 : 0.5, 1 - leaveUnits);
    flags.add('corrected');
    result.units = units(worked, leaveUnits);
    result.status = worked >= 1 ? 'present' : worked > 0 ? 'half_day' : 'absent';
  } else if (date > localDateOf(at, zone)) {
    result.status = 'upcoming';
  } else if (!over) {
    // Today with nobody in yet. Flexible hours have no start time to be late for.
    result.status = shift && at > shift.startAt.getTime() + rules.lateGraceMinutes * MINUTE ? 'not_in' : 'not_due';
  } else {
    result.status = 'absent';
    result.units = units(0, leaveUnits);
  }

  result.flags = [...flags];
  return result;
}

export interface PeriodSummary {
  /** Working days that can be counted: over, or with a closed punch. */
  workingDays: number;
  /** Days with a full day's work. */
  presentDays: number;
  /** Days with half a day's work. */
  halfDays: number;
  /** Leave of every kind, paid and unpaid together. */
  leaveDays: number;
  /** The part of `leaveDays` that is unpaid leave. */
  unpaidLeaveDays: number;
  /** Includes the missing half of every half-day. */
  absentDays: number;
  /** Days with a check-in and no check-out, not yet decided. */
  unresolvedDays: number;
  lateEntries: number;
  earlyDepartures: number;
  correctedDays: number;
  holidays: number;
  weeklyOffs: number;
  /** Days off or holidays that were worked. */
  offDaysWorked: number;
  /** Time worked on closed days, working days and days off alike. */
  workedMinutes: number;
}

/**
 * The totals for a run of days. It is plain addition over `evaluateDay`, so a summary is the
 * same wherever it is shown, and it always holds that
 * present + half-days ÷ 2 + leave + absent + unresolved = working days.
 */
export function summarize(days: readonly DayResult[]): PeriodSummary {
  const total: PeriodSummary = { workingDays: 0, presentDays: 0, halfDays: 0, leaveDays: 0, unpaidLeaveDays: 0, absentDays: 0, unresolvedDays: 0, lateEntries: 0, earlyDepartures: 0, correctedDays: 0, holidays: 0, weeklyOffs: 0, offDaysWorked: 0, workedMinutes: 0 };
  for (const day of days) {
    if (day.kind === 'holiday') total.holidays += 1;
    if (day.kind === 'weekly_off') total.weeklyOffs += 1;
    if (day.flags.includes('worked_on_off_day')) total.offDaysWorked += 1;
    if (day.flags.includes('late')) total.lateEntries += 1;
    if (day.flags.includes('early_departure')) total.earlyDepartures += 1;
    if (day.flags.includes('corrected')) total.correctedDays += 1;
    if (day.checkOutAt) total.workedMinutes += day.workedMinutes;
    if (!day.units) continue;
    total.workingDays += 1;
    if (day.units.worked === 1) total.presentDays += 1;
    if (day.units.worked === 0.5) total.halfDays += 1;
    total.leaveDays += day.units.leave;
    total.unpaidLeaveDays += Math.min(day.units.leave, day.leave?.unpaidUnits ?? 0);
    total.absentDays += day.units.absent;
    total.unresolvedDays += day.units.unresolved;
  }
  return total;
}

/** The words for each status, in one place, so the calendar, tables, badges and exports all say the same. */
export const STATUS_LABEL: Record<DayStatus, string> = {
  not_applicable: 'Not applicable',
  upcoming: 'Upcoming',
  not_due: 'Not due yet',
  not_in: 'Not in',
  working: 'Working',
  on_break: 'On break',
  present: 'Present',
  half_day: 'Half-day',
  absent: 'Absent',
  leave: 'Leave',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
  unresolved: 'Unresolved',
};

export const FLAG_LABEL: Record<DayFlag, string> = {
  late: 'Late',
  late_excused: 'Late, excused',
  early_departure: 'Early departure',
  short_hours: 'Short hours',
  worked_on_off_day: 'Worked on a day off',
  worked_on_leave: 'Worked while on leave',
  half_day_leave: 'Half-day leave',
  missing_check_out: 'Missing check-out',
  corrected: 'Corrected',
  pending_correction: 'Correction pending',
  pending_leave: 'Leave requested',
};
