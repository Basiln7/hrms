/*
 * Today, for one person: what the home page shows and which buttons it may offer.
 *
 * `composeToday` is what the API answers with. `liveDay` keeps the timer on the home page
 * running between two answers, counting exactly as the engine does. `describeToday` and its
 * neighbours put a state into words. All of them are plain functions of the facts and a
 * moment, so every state a person can be in is tested here, without a browser or a database.
 */
import { closableUntil, countMinutes, decideCheckIn, evaluateDay, FLAG_LABEL, shapeOf, workUnits, type DayContext, type DayFacts, type DayFlag, type DayInput, type DayResult } from './attendance';
import type { TodayPayload } from './contract';
import { dayInWords, localDateOf, localParts, MINUTE, minutesBetween, type Instant, type LocalDate } from './dates';
import { formatMinutes, shiftTime, type ScheduleRules } from './schedules';

const ms = (instant: Instant) => (instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant));

/** The facts of one day, with its date and the rules it was punched under. */
export interface DayRecord extends DayFacts {
  date: LocalDate;
  rules: ScheduleRules;
}

/** The person today is being worked out for. */
export interface TodayWho {
  /** The zone of the rules they work under now, or the company's when they have none. */
  timeZone: string;
  /** The rules in force for them today. */
  rules: ScheduleRules | null;
  ctx: DayContext;
}

/** What else is known about a date: approved leave, a leave request waiting, a correction waiting. */
export type DayExtras = Pick<DayInput, 'leave' | 'pendingCorrection' | 'pendingLeave'>;

/**
 * Today's state at a moment (plan.md, 6.4 and 6.5).
 *
 * @param open   their latest day with a check-in and no check-out, if there is one
 * @param nearby what is recorded for yesterday, today and tomorrow: the only days a check-in
 *               made now can belong to
 */
export function composeToday(now: Instant, who: TodayWho, open: DayRecord | null, nearby: readonly DayRecord[], extras: (date: LocalDate) => DayExtras = () => ({})): TodayPayload {
  const at = ms(now);
  const today = localDateOf(at, who.timeZone);
  const base = { serverNow: new Date(at).toISOString(), today, timeZone: who.timeZone, rules: who.rules };
  const read = (date: LocalDate, record: DayRecord | null) => evaluateDay(date, at, who.ctx, { record, ...extras(date) });

  // A day that is open and can still be closed comes first: it is the one the buttons act on.
  if (open?.checkInAt && !open.checkOutAt && at < closableUntil(open.date, open.checkInAt, open.rules, who.ctx).getTime()) {
    const day = read(open.date, open);
    const onBreak = day.onBreakSince !== null;
    return {
      ...base,
      day,
      dayRules: open.rules,
      hours: shapeOf(open.date, who.ctx, open.rules)?.hours ?? null,
      breaks: [...open.breaks],
      openFromEarlier: open.date < today,
      can: { checkIn: false, checkOut: true, startBreak: open.rules.break.mode === 'tracked' && !onBreak, endBreak: onBreak },
      checkInBlocked: null,
    };
  }

  // Otherwise: the day a check-in made now would belong to, or plain today when none can be made.
  const decision = decideCheckIn(at, who.timeZone, who.ctx);
  const date = decision.allowed ? decision.date : today;
  const found = nearby.find((record) => record.date === date) ?? null;
  // A day document can exist without a punch (HR left a note on it): that is not a check-in.
  const punched = found?.checkInAt ? found : null;
  const shape = shapeOf(date, who.ctx, punched?.rules);
  const checkInBlocked = !decision.allowed ? decision.reason : punched ? `You have already checked in for ${date === today ? 'today' : dayInWords(date)}. If that was a mistake, it can be put right with a correction.` : null;
  return {
    ...base,
    day: read(date, found),
    dayRules: shape?.rules ?? null,
    hours: shape?.hours ?? null,
    breaks: punched ? [...punched.breaks] : [],
    openFromEarlier: false,
    can: { checkIn: decision.allowed && !punched, checkOut: false, startBreak: false, endBreak: false },
    checkInBlocked,
  };
}

/** A day that is open, counted at a moment. */
export interface LiveDay {
  grossMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
  /**
   * Whether the worked time is moving right now. It stands still on a recorded break, and
   * during the time a fixed break is being taken off (plan.md, 6.3).
   */
  moving: boolean;
  /** Seconds into the current minute while it is moving, so a clock can tick. 0 while it stands still. */
  seconds: number;
  /** The day can no longer be checked out: the timer has stopped for good. */
  ended: boolean;
  /** While on a recorded break: how long it has run, in whole minutes. */
  onBreakMinutes: number | null;
  /** What the day would count as if it were checked out now. Null when its length decides nothing: a day off, a day of leave. */
  wouldCountAs: 'present' | 'half_day' | 'absent' | null;
}

/**
 * The open day in `today`, counted at `now`: the same arithmetic the server will do at
 * check-out, so the timer shows what would be recorded. Null when no day is open.
 *
 * `now` must be the server's time (see serverClock.ts), never the device's.
 */
export function liveDay(today: TodayPayload, now: Instant): LiveDay | null {
  const { day, dayRules, hours } = today;
  if (!today.can.checkOut || !day.checkInAt || !dayRules) return null;
  // The timer stops where the day stops being closable: past that, nothing more is counted.
  const limit = day.closableUntil ? Date.parse(day.closableUntil) : Infinity;
  const at = Math.min(ms(now), limit);
  const count = (moment: number) => countMinutes(day.checkInAt!, moment, today.breaks, dayRules.break);
  const here = count(at);
  const moving = at < limit && count(at + MINUTE).worked > here.worked;

  let wouldCountAs: LiveDay['wouldCountAs'] = null;
  if (day.kind === 'working' && hours && day.status !== 'leave') {
    const units = workUnits(hours, here.worked, day.flags.includes('half_day_leave') ? 0.5 : 1);
    wouldCountAs = units >= 1 ? 'present' : units > 0 ? 'half_day' : 'absent';
  }
  return {
    grossMinutes: here.gross,
    breakMinutes: here.break,
    workedMinutes: here.worked,
    moving,
    seconds: moving ? Math.floor((((at % MINUTE) + MINUTE) % MINUTE) / 1000) : 0,
    ended: at >= limit,
    onBreakMinutes: day.onBreakSince ? Math.max(0, minutesBetween(day.onBreakSince, at)) : null,
    wouldCountAs,
  };
}

export interface LiveWords {
  /**
   * How far the day is toward counting in full: a fraction from 0 to 1, where on the way half
   * a day is reached, and what is still missing in words. Null when the day's length decides
   * nothing (a day off, a day of leave).
   */
  progress: { fraction: number; halfAt: number | null; text: string } | null;
  /** Why the worked time is standing still, when it is. */
  paused: string | null;
}

/** The running day in words: what is still needed, and why the timer has stopped when it has. */
export function liveWords(today: TodayPayload, live: LiveDay): LiveWords {
  const { hours, dayRules, day } = today;
  const rule = dayRules?.break;

  let paused: string | null = null;
  if (live.ended) paused = 'This day can no longer be checked out. Ask for a correction of the missing check-out.';
  else if (!live.moving && live.onBreakMinutes !== null) paused = `Paused: on a break for ${formatMinutes(live.onBreakMinutes)}.`;
  else if (!live.moving && rule && rule.mode !== 'none' && live.breakMinutes < rule.minutes) {
    paused = `Paused: your ${formatMinutes(rule.minutes)} break is being taken off now.${live.breakMinutes > 0 ? ` ${formatMinutes(live.breakMinutes)} of it so far.` : ''}`;
  }

  if (live.wouldCountAs === null || !hours) return { progress: null, paused };
  const { workedMinutes: worked } = live;
  const more = (target: number) => formatMinutes(target - worked);
  if (day.flags.includes('half_day_leave')) {
    const done = worked >= hours.halfDayMinutes;
    return { progress: { fraction: hours.halfDayMinutes > 0 ? Math.min(1, worked / hours.halfDayMinutes) : 1, halfAt: null, text: done ? 'The half of today that is not leave is complete.' : `${more(hours.halfDayMinutes)} more completes the half of today that is not leave.` }, paused };
  }
  const text =
    live.wouldCountAs === 'present'
      ? `A full day is reached.${hours.requiredMinutes > worked ? ` ${more(hours.requiredMinutes)} more makes the ${formatMinutes(hours.requiredMinutes)} expected.` : ''}`
      : live.wouldCountAs === 'half_day'
        ? `Half a day is reached. ${more(hours.fullDayMinutes)} more makes a full day.`
        : `${more(hours.halfDayMinutes)} more makes half a day, ${more(hours.fullDayMinutes)} a full day.`;
  return {
    progress: { fraction: hours.fullDayMinutes > 0 ? Math.min(1, worked / hours.fullDayMinutes) : 1, halfAt: hours.halfDayMinutes > 0 && hours.halfDayMinutes < hours.fullDayMinutes ? hours.halfDayMinutes / hours.fullDayMinutes : null, text },
    paused,
  };
}

/** The states the home page tells apart (plan.md, 6.5). */
export type TodayState = 'no_schedule' | 'not_counted' | 'day_off' | 'on_leave' | 'not_due' | 'not_in' | 'working' | 'on_break' | 'checked_out' | 'missing_check_out';

export type Tone = 'neutral' | 'good' | 'warn';

export interface TodayWords {
  state: TodayState;
  /** Two or three words: what is true right now. */
  headline: string;
  /** A sentence or two that say the rest. */
  lines: string[];
  tone: Tone;
}

/** Today's state in words, as it was at the moment the server answered. */
export function describeToday(today: TodayPayload): TodayWords {
  const { day, can } = today;
  const zone = today.dayRules?.timeZone ?? today.timeZone;
  const time = (moment: string) => localParts(moment, zone).time;
  // A night shift's day is not the calendar's: then the day is named, never called "today".
  const otherDay = day.date !== today.today;
  const on = otherDay ? ` on ${dayInWords(day.date)}` : '';
  const theDay = otherDay ? dayInWords(day.date) : 'Today';
  const offDay = day.kind === 'weekly_off' || day.kind === 'holiday';
  const offDayIs = day.kind === 'holiday' ? `a holiday${day.holiday ? ` (${day.holiday.name})` : ''}` : 'your weekly off';

  if (day.kind === null) {
    if (!today.rules) return { state: 'no_schedule', headline: 'No work schedule yet', lines: ['Attendance is recorded once HR gives you a work schedule. Until then there is nothing to check in to.'], tone: 'neutral' };
    return { state: 'not_counted', headline: 'Not counted today', lines: [today.checkInBlocked ?? 'Attendance is not being counted for you today. Ask HR if that is wrong.'], tone: 'neutral' };
  }

  if (can.checkOut && day.checkInAt) {
    const lines: string[] = [];
    if (today.openFromEarlier) {
      lines.push(`Still checked in since ${dayInWords(day.date)}, ${time(day.checkInAt)}.`);
      lines.push(`Checking out records the time as it is now${day.closableUntil ? `, and is possible until ${time(day.closableUntil)}` : ''}. If you left earlier and forgot to check out, do not check out now: let the day close by itself and ask for a correction of the check-out.`);
    } else lines.push(`Checked in at ${time(day.checkInAt)}.`);
    if (day.onBreakSince) lines.push(`On a break since ${time(day.onBreakSince)}.`);
    if (offDay) lines.push(`${theDay} is ${offDayIs}: the hours are recorded as work on a day off.`);
    if (day.status === 'leave') lines.push('You have approved leave for this day. The hours are recorded, and the day still counts as leave.');
    return { state: day.onBreakSince ? 'on_break' : 'working', headline: day.onBreakSince ? 'On break' : 'Working', lines, tone: day.onBreakSince ? 'neutral' : 'good' };
  }

  if (day.checkInAt && day.checkOutAt) {
    const span = `${otherDay ? `${theDay}: ` : ''}${time(day.checkInAt)} to ${time(day.checkOutAt)}, ${formatMinutes(day.workedMinutes)} worked${day.breakMinutes > 0 ? ` after ${formatMinutes(day.breakMinutes)} of break` : ''}.`;
    const subject = otherDay ? 'The day' : 'Today';
    const halfLeave = day.flags.includes('half_day_leave');
    let verdict: string;
    let tone: Tone = 'neutral';
    if (offDay) verdict = 'Recorded as work on a day off.';
    else if (day.status === 'leave') verdict = `${subject} counts as approved leave. The hours are recorded.`;
    else if (day.status === 'present') {
      verdict = `${subject} counts as a full day.`;
      tone = 'good';
    } else if (day.status === 'half_day') {
      verdict = halfLeave ? `With your half-day leave, ${subject.toLowerCase()} is complete.` : `${subject} counts as a half-day${today.hours ? `: a full day needs ${formatMinutes(today.hours.fullDayMinutes)}` : ''}.`;
      tone = halfLeave ? 'good' : 'warn';
    } else {
      verdict = `${halfLeave ? 'The half that is not leave' : subject} counts as absent${today.hours ? `: half a day needs ${formatMinutes(today.hours.halfDayMinutes)}` : ''}.`;
      tone = 'warn';
    }
    return { state: 'checked_out', headline: 'Checked out', lines: [span, verdict], tone };
  }

  if (day.checkInAt) {
    const verdict =
      day.status === 'unresolved' ? 'The day stays unresolved until it is corrected.' : day.status === 'half_day' ? 'It counts as a half-day unless it is corrected.' : day.status === 'absent' ? 'It counts as absent unless it is corrected.' : 'No hours are counted for it until it is corrected.';
    return { state: 'missing_check_out', headline: 'Missing check-out', lines: [`You checked in at ${time(day.checkInAt)}${on} and did not check out in time.`, verdict], tone: 'warn' };
  }

  // Nothing punched from here on.
  if (day.status === 'leave') return { state: 'on_leave', headline: 'On leave', lines: ['You have approved leave today.', ...(can.checkIn ? ['If you are working anyway, you can still check in.'] : [])], tone: 'neutral' };
  if (offDay) {
    const lines = can.checkIn ? [`Today is ${offDayIs}.`, 'If you are working anyway, you can check in: the hours are recorded as work on a day off.'] : [today.checkInBlocked ?? `Today is ${offDayIs}.`];
    return { state: 'day_off', headline: day.kind === 'holiday' ? 'Holiday' : 'Weekly off', lines, tone: 'neutral' };
  }

  const start = day.shiftStartAt ? time(day.shiftStartAt) : null;
  const end = day.shiftEndAt ? time(day.shiftEndAt) : null;
  const blocked = !can.checkIn && today.checkInBlocked ? [today.checkInBlocked] : [];

  if (day.status === 'absent') {
    const lines = [`Your day${on} ended${end ? ` at ${end}` : ''} with no check-in, so it counts as absent.`, ...(can.checkIn ? ['If you are only starting now, you can still check in.'] : blocked)];
    return { state: 'not_in', headline: 'Not checked in', lines, tone: 'warn' };
  }
  if (day.status === 'not_in') {
    return { state: 'not_in', headline: 'Not checked in', lines: [`Your day started at ${start}${on}.${can.checkIn ? ' Checking in now is a late entry.' : ''}`, ...blocked], tone: 'warn' };
  }

  // Not due yet, or a day that has not begun (a shift at midnight opens the evening before).
  const lines: string[] = [];
  if (start && day.shiftStartAt) {
    const grace = today.dayRules?.lateGraceMinutes ?? 0;
    const started = Date.parse(day.shiftStartAt) <= Date.parse(today.serverNow);
    if (started) lines.push(`Your day started at ${start}${on}.${grace > 0 ? ` Checking in by ${shiftTime(start, grace)} is still on time.` : ''}`);
    else lines.push(`Your day starts at ${start}${on}.${grace > 0 && can.checkIn ? ` Arriving up to ${shiftTime(start, grace)} is on time.` : ''}`);
  } else {
    lines.push(`Flexible hours${day.requiredMinutes ? `: today needs ${formatMinutes(day.requiredMinutes)} of work` : ''}.${can.checkIn ? ' Check in when you start.' : ''}`);
  }
  return { state: 'not_due', headline: 'Not checked in', lines: [...lines, ...blocked], tone: 'neutral' };
}

export interface FlagWords {
  flag: DayFlag;
  text: string;
  tone: Tone;
}

/** A day's flags in words, with the minutes that go with them: "Late by 26 min", "Left 2 h early". */
export function flagWords(day: DayResult): FlagWords[] {
  const has = (flag: DayFlag) => day.flags.includes(flag);
  const words: FlagWords[] = [];
  if (has('late')) words.push(has('late_excused') ? { flag: 'late_excused', text: `Late by ${formatMinutes(day.lateMinutes)}, excused`, tone: 'neutral' } : { flag: 'late', text: `Late by ${formatMinutes(day.lateMinutes)}`, tone: 'warn' });
  if (has('early_departure')) words.push({ flag: 'early_departure', text: `Left ${formatMinutes(day.earlyMinutes)} early`, tone: 'warn' });
  if (has('short_hours') && day.requiredMinutes !== null) words.push({ flag: 'short_hours', text: `Short by ${formatMinutes(day.requiredMinutes - day.workedMinutes)}`, tone: 'neutral' });
  // "Unresolved" already says the check-out is missing. The flag is worth its own words only
  // when the schedule counts such a day as something else (a half-day, an absence).
  if (has('missing_check_out') && day.status !== 'unresolved') words.push({ flag: 'missing_check_out', text: FLAG_LABEL.missing_check_out, tone: 'warn' });
  for (const flag of ['worked_on_off_day', 'worked_on_leave', 'half_day_leave', 'corrected', 'pending_correction', 'pending_leave'] as const) {
    if (has(flag)) words.push({ flag, text: FLAG_LABEL[flag], tone: 'neutral' });
  }
  return words;
}

/**
 * What checking out at this moment would mean, said before it is done. Checking out cannot be
 * taken back, so the person is told what the day will count as first.
 */
export function checkOutInWords(today: TodayPayload, now: Instant): { lines: string[]; warn: boolean } | null {
  const live = liveDay(today, now);
  if (!live) return null;
  const { day, hours, dayRules } = today;
  const zone = dayRules?.timeZone ?? today.timeZone;
  const otherDay = day.date !== today.today;
  const subject = otherDay ? dayInWords(day.date) : 'today';
  const lines = [`You have worked ${formatMinutes(live.workedMinutes)}${otherDay ? `, counted for ${subject}` : ''}.`];

  if (live.wouldCountAs === 'present') lines.push('That is a full day.');
  else if (live.wouldCountAs === 'half_day' && hours) lines.push(day.flags.includes('half_day_leave') ? 'With your half-day leave, that completes the day.' : `Checking out now makes ${subject} a half-day: a full day needs ${formatMinutes(hours.fullDayMinutes)}.`);
  else if (live.wouldCountAs === 'absent' && hours) lines.push(`Checking out now makes ${subject} count as absent: half a day needs ${formatMinutes(hours.halfDayMinutes)}.`);
  else if (day.status === 'leave') lines.push('The day still counts as approved leave.');
  else lines.push('The hours are recorded as work on a day off.');

  // Leaving early is its own mark, whatever the day counts as. Half-day leave may cover it: then the server decides.
  const leavingEarly = dayRules?.earlyLeave.tracked && day.shiftEndAt && live.wouldCountAs !== null && !day.flags.includes('half_day_leave') && ms(now) < Date.parse(day.shiftEndAt) - dayRules.earlyLeave.graceMinutes * MINUTE;
  if (leavingEarly) lines.push(`Leaving before ${localParts(day.shiftEndAt!, zone).time} is also marked as an early departure.`);

  lines.push(`You cannot check in again for ${otherDay ? 'that day' : 'today'} afterwards.`);
  const shortDay = live.wouldCountAs === 'half_day' && !day.flags.includes('half_day_leave');
  return { lines, warn: shortDay || live.wouldCountAs === 'absent' };
}
