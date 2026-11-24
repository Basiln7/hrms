/*
 * Attendance corrections (plan.md, section 8).
 *
 * A correction never replaces what was punched: it is a change laid over the day's facts,
 * recorded with what was there before. An employee asks for one and someone else decides; HR
 * can also make one directly. Either way the same few facts change (the two times, a status
 * set by hand, a late entry excused), and how the day then reads is still the engine's work.
 *
 * Everything here is a plain function: which kinds of correction fit a day, whether a request
 * may be sent, whether its times make sense, who may decide it, and what the day would read
 * as afterwards. The API enforces with these; the web app explains with the same code.
 */
import { closableUntil, evaluateDay, windowOf, type DayContext, type DayFacts, type DayInput, type DayResult, type DayStatus } from './attendance';
import { addDays, dayInWords, fromLocalDateTime, isLocalDateTime, localParts, monthInWords, monthOf, startOfDay, truncateToMinute, type Instant, type LocalDate, type LocalDateTime } from './dates';
import { managerChain, type OrgNode } from './org';
import { can, isPrivileged } from './roles';
import { formatMinutes, type ScheduleRules } from './schedules';

export const CORRECTION_TYPES = ['missing_check_in', 'missing_check_out', 'incorrect_check_in', 'incorrect_check_out', 'forgot_attendance', 'late_explanation', 'half_day_correction', 'absent_correction'] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

/** The eight kinds, in words, and what each asks the employee for. */
export const CORRECTION_INFO: Record<CorrectionType, { label: string; hint: string; asks: { checkIn: boolean; checkOut: boolean; status: boolean } }> = {
  missing_check_in: { label: 'Missing check-in', hint: 'You are at work and did not check in. Give the time you started; you still check out yourself.', asks: { checkIn: true, checkOut: false, status: false } },
  missing_check_out: { label: 'Missing check-out', hint: 'You checked in and never checked out. Give the time you left.', asks: { checkIn: false, checkOut: true, status: false } },
  incorrect_check_in: { label: 'Incorrect check-in', hint: 'The check-in recorded is not when you started. Give the right time.', asks: { checkIn: true, checkOut: false, status: false } },
  incorrect_check_out: { label: 'Incorrect check-out', hint: 'The check-out recorded is not when you left. Give the right time.', asks: { checkIn: false, checkOut: true, status: false } },
  forgot_attendance: { label: 'Forgot to check in and out', hint: 'You worked and nothing was recorded. Give both times.', asks: { checkIn: true, checkOut: true, status: false } },
  late_explanation: { label: 'Late entry explanation', hint: 'The day stays late and is marked as excused. The times do not change.', asks: { checkIn: false, checkOut: false, status: false } },
  half_day_correction: { label: 'Half-day correction', hint: 'The day counted as a half-day and should count in full. The times do not change.', asks: { checkIn: false, checkOut: false, status: true } },
  absent_correction: { label: 'Absent correction', hint: 'The day counted as absent and should count as present or as a half-day. The times do not change.', asks: { checkIn: false, checkOut: false, status: true } },
};

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'var(--amber)' },
  approved: { label: 'Approved', tone: 'var(--green)' },
  rejected: { label: 'Rejected', tone: 'var(--red)' },
  cancelled: { label: 'Cancelled', tone: 'var(--text-3)' },
};

export const REASON_MIN = 5;
export const REASON_MAX = 500;
export const DAY_NOTE_MAX = 500;

/**
 * What a correction sets on a day. Only the facts named are touched; the rest of the day
 * (its breaks, the other time) stays as it is.
 */
export interface CorrectionChange {
  checkInAt?: string | null;
  checkOutAt?: string | null;
  /** A status set by hand. Null takes one away again. */
  override?: 'present' | 'half_day' | null;
  lateExcused?: boolean;
}

/** The four facts a correction can touch, as they stand on a day. */
export interface CorrectableFacts {
  checkInAt: string | null;
  checkOutAt: string | null;
  override: 'present' | 'half_day' | null;
  lateExcused: boolean;
}

export const correctableOf = (facts: DayFacts | null): CorrectableFacts => ({ checkInAt: facts?.checkInAt ?? null, checkOutAt: facts?.checkOutAt ?? null, override: facts?.override ?? null, lateExcused: facts?.lateExcused ?? false });

/** A request to correct one day. */
export interface CorrectionRequest {
  id: string;
  employeeId: string;
  date: LocalDate;
  type: CorrectionType;
  /** The day as it was when the request was sent: what was recorded, and how it read. */
  original: CorrectableFacts & { status: DayStatus; version: number };
  requested: CorrectionChange;
  reason: string;
  status: RequestStatus;
  /** False between a decision and its being applied to the day. Settling again changes nothing. */
  settled: boolean;
  submittedAt: string;
  decidedBy: string | null;
  /** A snapshot, so the record still reads after a rename. */
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
}

/** What the employee fills in. Times are wall-clock moments in the zone of their schedule. */
export interface CorrectionInput {
  date: LocalDate;
  type: CorrectionType;
  checkIn: LocalDateTime | null;
  checkOut: LocalDateTime | null;
  status: 'present' | 'half_day' | null;
  reason: string;
}

/** What HR fills in to correct a day directly: the four facts as they should be, and why. */
export interface DirectCorrectionInput {
  checkIn: LocalDateTime | null;
  checkOut: LocalDateTime | null;
  override: 'present' | 'half_day' | null;
  lateExcused: boolean;
  reason: string;
  /** The version of the day HR was looking at. A day that has changed since is not overwritten. */
  dayVersion: number;
}

/** A day as the correction rules see it. */
export interface DayState {
  date: LocalDate;
  /** How it reads now. */
  day: DayResult;
  /** What is recorded. Null when nothing is. */
  facts: DayFacts | null;
  /** The rules it is judged by. Null when the day does not apply to the person. */
  rules: ScheduleRules | null;
}

const ms = (instant: Instant) => (instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant));

/** A day with a change laid over it. */
export function applyChange(facts: DayFacts | null, change: CorrectionChange): DayFacts {
  const now = correctableOf(facts);
  const timesChange = 'checkInAt' in change || 'checkOutAt' in change;
  return {
    checkInAt: 'checkInAt' in change ? (change.checkInAt ?? null) : now.checkInAt,
    checkOutAt: 'checkOutAt' in change ? (change.checkOutAt ?? null) : now.checkOutAt,
    breaks: facts?.breaks ?? [],
    override: 'override' in change ? (change.override ?? null) : now.override,
    lateExcused: 'lateExcused' in change ? Boolean(change.lateExcused) : now.lateExcused,
    corrected: Boolean(facts?.corrected) || timesChange,
  };
}

/** Which kind of history row a change is: times corrected, a status set by hand, or a late entry excused. */
export function changeKind(change: CorrectionChange): 'corrected' | 'overridden' | 'excused' {
  if ('checkInAt' in change || 'checkOutAt' in change) return 'corrected';
  return 'override' in change ? 'overridden' : 'excused';
}

/**
 * The kinds of correction that fit a day as it is now. A kind that does not fit is not
 * offered and is refused: there is no "incorrect check-out" for a day with no check-out.
 */
export function correctionTypesFor(state: DayState): CorrectionType[] {
  const { day, facts, rules } = state;
  if (day.kind === null || !rules) return [];
  const working = day.kind === 'working';
  const hasIn = Boolean(facts?.checkInAt);
  const hasOut = Boolean(facts?.checkOutAt);
  // A day off is only ever corrected for work that was done on it, where the schedule records such work.
  if (!working && !hasIn && rules.offDayWork !== 'allowed') return [];

  const types: CorrectionType[] = [];
  if (!hasIn) types.push('forgot_attendance', 'missing_check_in');
  // While the day can still be checked out there is nothing to ask for: checking out is the way.
  if (hasIn && !hasOut && day.closableUntil === null) types.push('missing_check_out');
  if (hasIn) types.push('incorrect_check_in');
  if (hasOut) types.push('incorrect_check_out');
  if (day.flags.includes('late') && !day.flags.includes('late_excused')) types.push('late_explanation');
  if (working && day.status === 'half_day' && !facts?.override) types.push('half_day_correction');
  if (working && day.status === 'absent') types.push('absent_correction');
  return types;
}

/**
 * Why a correction for a date cannot be asked for at all, or null. The limits are the
 * employee's own: how far back, and how many for the days of one month.
 *
 * @param usedInMonth requests already made for days in the same month that are waiting or approved
 */
export function requestBlocker(date: LocalDate, today: LocalDate, limits: ScheduleRules['corrections'], usedInMonth: number, hasOpenRequest: boolean): string | null {
  if (date > today) return 'A day that has not come yet has nothing to correct.';
  if (hasOpenRequest) return 'A correction for this day is already waiting for a decision. Cancel it first to ask for something else.';
  const earliest = addDays(today, -limits.windowDays);
  if (date < earliest) return `Your schedule lets you ask for a correction up to ${limits.windowDays} ${limits.windowDays === 1 ? 'day' : 'days'} back: from ${dayInWords(earliest)}. For an older day, ask HR.`;
  if (limits.maxPerMonth !== null && usedInMonth >= limits.maxPerMonth) {
    return `Your schedule allows ${limits.maxPerMonth} ${limits.maxPerMonth === 1 ? 'correction' : 'corrections'} for the days of one month, and ${monthInWords(monthOf(date))} already has ${usedInMonth}. Ask HR.`;
  }
  return null;
}

/** "18:10", or "01:00 on Tuesday 8 December" when it is not on the day itself. */
function stamp(moment: number, date: LocalDate, zone: string): string {
  const parts = localParts(moment, zone);
  return parts.date === date ? parts.time : `${parts.time} on ${dayInWords(parts.date)}`;
}

/**
 * What is wrong with a day's two times once a change is laid over it, by field. The bounds are
 * the same ones a real punch has: a check-in falls inside the day's window, and a check-out
 * comes after it and no later than the day could have been checked out. Nothing is in the future.
 */
function timeErrors(date: LocalDate, facts: CorrectableFacts, changing: { checkIn: boolean; checkOut: boolean }, rules: ScheduleRules, ctx: DayContext, now: Instant): Record<string, string> {
  const errors: Record<string, string> = {};
  const zone = rules.timeZone;
  const at = ms(now);
  const inAt = facts.checkInAt ? truncateToMinute(facts.checkInAt).getTime() : null;
  const outAt = facts.checkOutAt ? truncateToMinute(facts.checkOutAt).getTime() : null;

  if (inAt !== null && changing.checkIn) {
    // A day off has no shift: its check-in belongs anywhere in the calendar day.
    const window = windowOf(date, ctx) ?? { opensAt: startOfDay(date, zone), closesAt: startOfDay(addDays(date, 1), zone) };
    if (inAt < window.opensAt.getTime() || inAt >= window.closesAt.getTime()) {
      errors.checkIn = `A check-in for ${dayInWords(date)} falls between ${stamp(window.opensAt.getTime(), date, zone)} and ${stamp(window.closesAt.getTime(), date, zone)}.`;
    } else if (inAt > at) errors.checkIn = 'That time has not come yet.';
  }

  if (outAt !== null) {
    // The message goes to the field that is being changed: moving a check-in past the check-out is the check-in's fault.
    const field = changing.checkOut ? 'checkOut' : 'checkIn';
    if (inAt === null) errors.checkOut ??= 'A check-out needs a check-in to go with it.';
    else if (outAt <= inAt) errors[field] ??= changing.checkOut ? 'The check-out has to be after the check-in.' : `The check-in has to be before the check-out at ${stamp(outAt, date, zone)}.`;
    else {
      const until = closableUntil(date, new Date(inAt), rules, ctx).getTime();
      if (outAt > until) {
        errors[field] ??= `With a check-in at ${stamp(inAt, date, zone)}, the day could be checked out until ${stamp(until, date, zone)} at the latest: ${formatMinutes(rules.missingCheckOut.closeAfterMinutes)} after check-in, and not after the next working day opens.`;
      } else if (outAt > at && changing.checkOut) errors.checkOut ??= 'That time has not come yet.';
    }
  }
  return errors;
}

const moment = (value: LocalDateTime | null, zone: string): string | null => (value && isLocalDateTime(value) ? fromLocalDateTime(value, zone).toISOString() : null);

function reasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REASON_MIN) return 'Say why, in a few words.';
  if (length > REASON_MAX) return `Keep this to ${REASON_MAX} characters or fewer.`;
  return null;
}

/**
 * Checks a request against the day as it is now. Returns what is wrong, field by field, and,
 * when nothing is, the change the request asks for. The same check runs when the request is
 * sent and again when it is approved, so a request that no longer fits the day is not applied.
 */
export function validateCorrection(input: Omit<CorrectionInput, 'date'>, state: DayState, ctx: DayContext, now: Instant): { errors: Record<string, string>; change: CorrectionChange | null } {
  const errors: Record<string, string> = {};
  const reason = reasonError(input.reason);
  if (reason) errors.reason = reason;
  const { rules } = state;
  if (!rules || !correctionTypesFor(state).includes(input.type)) {
    errors.type = 'That kind of correction does not fit this day as it is now.';
    return { errors, change: null };
  }

  const { asks } = CORRECTION_INFO[input.type];
  const change: CorrectionChange = {};
  if (asks.checkIn) {
    const at = moment(input.checkIn, rules.timeZone);
    if (at) change.checkInAt = at;
    else errors.checkIn = 'Give the check-in time.';
  }
  if (asks.checkOut) {
    const at = moment(input.checkOut, rules.timeZone);
    if (at) change.checkOutAt = at;
    else errors.checkOut = 'Give the check-out time.';
  }
  if (asks.status) {
    const allowed = input.type === 'half_day_correction' ? ['present'] : ['present', 'half_day'];
    if (input.status && allowed.includes(input.status)) change.override = input.status;
    else errors.status = 'Choose what the day should count as.';
  }
  if (input.type === 'late_explanation') change.lateExcused = true;

  // "Incorrect" means it should be something else: the time already recorded is not a correction.
  const sameMinute = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b) && truncateToMinute(a!).getTime() === truncateToMinute(b!).getTime();
  if (input.type === 'incorrect_check_in' && sameMinute(change.checkInAt, state.facts?.checkInAt)) errors.checkIn = 'That is the check-in already recorded. Give the time it should be.';
  if (input.type === 'incorrect_check_out' && sameMinute(change.checkOutAt, state.facts?.checkOutAt)) errors.checkOut = 'That is the check-out already recorded. Give the time it should be.';

  if (!errors.checkIn && !errors.checkOut && (asks.checkIn || asks.checkOut)) {
    const after = correctableOf(applyChange(state.facts, change));
    Object.assign(errors, timeErrors(state.date, after, { checkIn: asks.checkIn, checkOut: asks.checkOut }, rules, ctx, now));
    // A check-in alone only helps while the day can still be checked out. After that both times are missing.
    if (input.type === 'missing_check_in' && !errors.checkIn && after.checkInAt && ms(now) >= closableUntil(state.date, after.checkInAt, rules, ctx).getTime()) {
      errors.checkIn = 'That day can no longer be checked out, so its check-out is missing too. Choose “Forgot to check in and out” and give both times.';
    }
  }
  return { errors, change: Object.keys(errors).length === 0 ? change : null };
}

/**
 * Checks a direct correction by HR: the four facts as they should be. HR is not held to the
 * employee's limits (how far back, how many), but the times obey the same bounds, a status is
 * set by hand only on a working day, and a correction that changes nothing is refused.
 */
export function validateDirectCorrection(input: Omit<DirectCorrectionInput, 'dayVersion'>, state: DayState, ctx: DayContext, now: Instant): { errors: Record<string, string>; change: CorrectionChange | null } {
  const errors: Record<string, string> = {};
  const reason = reasonError(input.reason);
  if (reason) errors.reason = reason;
  const { rules } = state;
  if (state.day.kind === null || !rules) return { errors: { ...errors, day: 'Attendance is not counted for them on this day, so there is nothing to correct.' }, change: null };
  if (state.date > localParts(now, rules.timeZone).date) return { errors: { ...errors, day: 'A day that has not come yet has nothing to correct.' }, change: null };

  if (input.checkIn !== null && !isLocalDateTime(input.checkIn)) errors.checkIn = 'Give the check-in time, or leave it empty.';
  if (input.checkOut !== null && !isLocalDateTime(input.checkOut)) errors.checkOut = 'Give the check-out time, or leave it empty.';
  if (input.override !== null && state.day.kind !== 'working') errors.override = 'A day off is not counted as present or half-day. Leave this as the hours say.';
  if (errors.checkIn || errors.checkOut || errors.override) return { errors, change: null };

  const before = correctableOf(state.facts);
  const wanted: CorrectableFacts = { checkInAt: moment(input.checkIn, rules.timeZone), checkOutAt: moment(input.checkOut, rules.timeZone), override: input.override, lateExcused: input.lateExcused };
  // A time that was left as it is keeps its seconds: only a field HR really changed is a change.
  const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : truncateToMinute(a).getTime() === truncateToMinute(b).getTime());
  const change: CorrectionChange = {};
  if (!same(before.checkInAt, wanted.checkInAt)) change.checkInAt = wanted.checkInAt;
  if (!same(before.checkOutAt, wanted.checkOutAt)) change.checkOutAt = wanted.checkOutAt;
  if (before.override !== wanted.override) change.override = wanted.override;
  if (before.lateExcused !== wanted.lateExcused) change.lateExcused = wanted.lateExcused;
  if (Object.keys(change).length === 0) return { errors: { ...errors, day: 'Nothing would change: the day already reads like this.' }, change: null };

  const after = correctableOf(applyChange(state.facts, change));
  Object.assign(errors, timeErrors(state.date, after, { checkIn: 'checkInAt' in change, checkOut: 'checkOutAt' in change }, rules, ctx, now));
  if (change.lateExcused && !errors.checkIn && !errors.checkOut && !previewCorrection(state, change, ctx, now).flags.includes('late')) errors.lateExcused = 'The day is not a late entry, so there is nothing to excuse.';
  return { errors, change: Object.keys(errors).length === 0 ? change : null };
}

/**
 * Why a request that was sound when it was sent no longer fits the day as it is now, or null.
 * Checked again at the moment of approval: a day can change while a request waits.
 */
export function staleProblem(request: Pick<CorrectionRequest, 'type' | 'requested'>, state: DayState, ctx: DayContext, now: Instant): string | null {
  if (!state.rules || !correctionTypesFor(state).includes(request.type)) return 'The day has changed since this was asked for, and this kind of correction no longer fits it.';
  const after = correctableOf(applyChange(state.facts, request.requested));
  const errors = timeErrors(state.date, after, { checkIn: 'checkInAt' in request.requested, checkOut: 'checkOutAt' in request.requested }, state.rules, ctx, now);
  return Object.values(errors)[0] ?? null;
}

/** How the day would read with a change laid over it. Worked out by the engine, like any other day. */
export function previewCorrection(state: DayState, change: CorrectionChange, ctx: DayContext, now: Instant, extras: Pick<DayInput, 'leave'> = {}): DayResult {
  if (!state.rules) return state.day;
  return evaluateDay(state.date, now, ctx, { record: { ...applyChange(state.facts, change), rules: state.rules }, ...extras });
}

export type ApprovalVerdict = 'allowed' | 'own' | 'not_theirs';

/**
 * Whether someone may decide another person's request (plan.md, sections 4 and 8).
 *
 * - Never their own.
 * - HR and Admin decide anyone else's.
 * - A manager decides for the people whose manager chain leads to them, but never a request
 *   made by HR or an Admin: those go to another HR or Admin, so that making a second account
 *   your own manager is not a way to approve yourself.
 */
export function approvalVerdict(approver: Pick<OrgNode, 'id' | 'role'>, requesterId: string, people: readonly OrgNode[]): ApprovalVerdict {
  if (approver.id === requesterId) return 'own';
  const requester = people.find((p) => p.id === requesterId);
  if (!requester) return 'not_theirs';
  if (can(approver.role, 'requests.approveAll')) return 'allowed';
  if (isPrivileged(requester.role)) return 'not_theirs';
  return can(approver.role, 'team.approve') && managerChain(people, requesterId).includes(approver.id) ? 'allowed' : 'not_theirs';
}

/** Everyone whose requests a person may decide. */
export const decidableBy = (approver: Pick<OrgNode, 'id' | 'role'>, people: readonly OrgNode[]): string[] => people.filter((p) => approvalVerdict(approver, p.id, people) === 'allowed').map((p) => p.id);

/** A change in words, one line per fact: "Check-in 09:00", "Counts as present". */
export function changeInWords(change: CorrectionChange, date: LocalDate, zone: string): string[] {
  const lines: string[] = [];
  const time = (value: string | null | undefined) => (value ? stamp(Date.parse(value), date, zone) : 'removed');
  if ('checkInAt' in change) lines.push(`Check-in ${time(change.checkInAt)}`);
  if ('checkOutAt' in change) lines.push(`Check-out ${time(change.checkOutAt)}`);
  if ('override' in change) lines.push(change.override === 'present' ? 'Counts as present' : change.override === 'half_day' ? 'Counts as a half-day' : 'Counts as the hours say');
  if ('lateExcused' in change) lines.push(change.lateExcused ? 'Late entry excused' : 'Late entry no longer excused');
  return lines;
}
