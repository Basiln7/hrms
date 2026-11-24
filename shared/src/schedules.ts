/*
 * Work schedules: the rules one employee's attendance is judged by.
 *
 * Nothing here is a constant of the HRMS. Every number is a field of a set of rules, and each
 * employee works under their own copy (plan.md, section 6). This file says what a set of rules
 * is, whether it is sound, what it means in plain words, and which rules apply on a date.
 */
import { addDays, isLocalDate, isLocalTime, isTimeZone, minutesOfDay, WEEKDAY_NAMES, WEEKDAYS, type LocalDate, type LocalTime, type Weekday } from './dates';

export const SCHEDULE_NAME_MAX = 80;
export const DAY_MINUTES = 1440;

export type ScheduleKind = 'fixed' | 'flexible';

/** The hours of one working day. */
export interface DayHours {
  /** Fixed schedules only. An end at or before the start means the shift runs past midnight. */
  start: LocalTime | null;
  end: LocalTime | null;
  /** The time expected that day. */
  requiredMinutes: number;
  /** Worked time needed for the day to count in full. */
  fullDayMinutes: number;
  /** Worked time needed for half a day. Below it the day does not count. */
  halfDayMinutes: number;
}

/** A weekday is a day off, a normal day (the standard hours), or a day with hours of its own. */
export type DayRule = 'off' | 'standard' | DayHours;

export type BreakMode = 'none' | 'fixed' | 'tracked';
export type MissingCheckOut = 'unresolved' | 'half_day' | 'absent';

export interface BreakRule {
  mode: BreakMode;
  /** The break allowance. */
  minutes: number;
  /** The allowance is taken from time worked beyond this many minutes. */
  appliesAfter: number;
}

export interface ScheduleRules {
  /** The shift's name, e.g. "General 9 to 6". */
  name: string;
  kind: ScheduleKind;
  timeZone: string;
  standard: DayHours;
  days: Record<Weekday, DayRule>;
  break: BreakRule;
  /** Fixed only: arriving this long after the start is still on time. */
  lateGraceMinutes: number;
  /** Fixed only: how long before the start time check-in opens. */
  earlyCheckInMinutes: number;
  earlyLeave: { tracked: boolean; graceMinutes: number };
  missingCheckOut: { closeAfterMinutes: number; countsAs: MissingCheckOut };
  offDayWork: 'allowed' | 'blocked';
  corrections: { windowDays: number; maxPerMonth: number | null };
}

/** A named set of rules HR can give to many people. */
export interface Schedule {
  id: string;
  name: string;
  rules: ScheduleRules;
  /** Kept for the people already on it, but no longer offered. */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The rules one employee works under from a date: a frozen copy, never edited once it has started. */
export interface ScheduleAssignment {
  id: string;
  employeeId: string;
  effectiveFrom: LocalDate;
  /** The standard schedule the copy was taken from, or null for rules made for this person. */
  scheduleId: string | null;
  rules: ScheduleRules;
  /** Holiday calendars arrive in Phase 5. */
  holidayCalendarId: string | null;
  note: string;
  createdBy: string;
  /** A snapshot, so the history still reads after a rename. */
  createdByName: string;
  createdAt: string;
}

/** Where a new schedule starts in the form. Suggestions only: every value is saved with the schedule and can be changed. */
export function startingRules(timeZone: string): ScheduleRules {
  return {
    name: '',
    kind: 'fixed',
    timeZone,
    standard: { start: '09:00', end: '18:00', requiredMinutes: 480, fullDayMinutes: 450, halfDayMinutes: 240 },
    days: { mon: 'standard', tue: 'standard', wed: 'standard', thu: 'standard', fri: 'standard', sat: 'off', sun: 'off' },
    break: { mode: 'fixed', minutes: 60, appliesAfter: 300 },
    lateGraceMinutes: 10,
    earlyCheckInMinutes: 180,
    earlyLeave: { tracked: true, graceMinutes: 0 },
    missingCheckOut: { closeAfterMinutes: 960, countsAs: 'unresolved' },
    offDayWork: 'allowed',
    corrections: { windowDays: 7, maxPerMonth: null },
  };
}

/** The hours that apply on a weekday, or null when it is a day off. */
export function hoursFor(rules: ScheduleRules, weekday: Weekday): DayHours | null {
  const rule = rules.days[weekday];
  if (rule === 'off') return null;
  return rule === 'standard' ? rules.standard : rule;
}

export const workingDays = (rules: ScheduleRules): Weekday[] => WEEKDAYS.filter((day) => rules.days[day] !== 'off');

/** How long a fixed day runs from start to end, in minutes. 0 when the day has no start and end. */
export function spanMinutes(hours: DayHours): number {
  if (!hours.start || !hours.end) return 0;
  const span = minutesOfDay(hours.end) - minutesOfDay(hours.start);
  return span > 0 ? span : span + DAY_MINUTES;
}

/** Whether a fixed day's shift ends on the following calendar day. */
export const isOvernight = (hours: DayHours): boolean => Boolean(hours.start && hours.end) && minutesOfDay(hours.end!) <= minutesOfDay(hours.start!);

/**
 * The break time taken off a day's gross time (plan.md, 6.3).
 *
 * - `none`: nothing.
 * - `fixed`: the part of the allowance that fits after `appliesAfter`. Nothing up to it, then
 *   minute for minute up to the allowance, so worked time never goes down by staying longer.
 * - `tracked`: the breaks actually taken, or what `fixed` would take, whichever is more. So
 *   never pressing Break gains nothing.
 */
export function breakDeducted(rule: BreakRule, grossMinutes: number, takenMinutes = 0): number {
  if (rule.mode === 'none') return 0;
  const allowance = Math.min(rule.minutes, Math.max(0, grossMinutes - rule.appliesAfter));
  const deducted = rule.mode === 'tracked' ? Math.max(takenMinutes, allowance) : allowance;
  return Math.min(Math.max(0, deducted), Math.max(0, grossMinutes));
}

/** "7 h 30 min", "8 h", "45 min". */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** A time of day moved by some minutes, wrapping at midnight: 09:00 + 10 is 09:10. */
export function shiftTime(time: LocalTime, minutes: number): LocalTime {
  const total = (((minutesOfDay(time) + minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const isWholeNumber = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function validateHours(kind: ScheduleKind, hours: DayHours, breakRule: BreakRule, at: string, errors: Record<string, string>) {
  if (kind === 'fixed') {
    if (!isLocalTime(hours.start)) errors[`${at}.start`] = 'Enter the start time.';
    if (!isLocalTime(hours.end)) errors[`${at}.end`] = 'Enter the end time.';
    if (isLocalTime(hours.start) && isLocalTime(hours.end) && hours.start === hours.end) errors[`${at}.end`] = 'The end cannot be the same time as the start.';
  } else if (hours.start !== null || hours.end !== null) {
    errors[`${at}.start`] = 'A flexible schedule has no start or end time.';
  }

  if (!isWholeNumber(hours.requiredMinutes, 1, DAY_MINUTES)) errors[`${at}.requiredMinutes`] = 'Enter the hours expected, more than none and at most 24.';
  if (!isWholeNumber(hours.halfDayMinutes, 1, DAY_MINUTES)) errors[`${at}.halfDayMinutes`] = 'Enter the time needed for half a day.';
  if (!isWholeNumber(hours.fullDayMinutes, 1, DAY_MINUTES)) errors[`${at}.fullDayMinutes`] = 'Enter the time needed for a full day.';
  if (errors[`${at}.requiredMinutes`] || errors[`${at}.halfDayMinutes`] || errors[`${at}.fullDayMinutes`]) return;

  if (hours.fullDayMinutes > hours.requiredMinutes) errors[`${at}.fullDayMinutes`] = 'A full day cannot need more than the hours expected.';
  else if (hours.halfDayMinutes > hours.fullDayMinutes) errors[`${at}.halfDayMinutes`] = 'Half a day cannot need more than a full day.';

  if (kind === 'fixed' && !errors[`${at}.start`] && !errors[`${at}.end`]) {
    const needed = hours.requiredMinutes + (breakRule.mode === 'fixed' ? breakRule.minutes : 0);
    if (needed > spanMinutes(hours)) {
      errors[`${at}.requiredMinutes`] =
        breakRule.mode === 'fixed' ? `The hours expected and the ${formatMinutes(breakRule.minutes)} break do not fit between the start and the end.` : 'The hours expected do not fit between the start and the end.';
    }
  }
}

/**
 * Field-by-field problems with a set of rules; empty when they are sound. Keys are paths into
 * the rules ("standard.start", "days.fri.end", "break.minutes"), so a form can put each message
 * beside its field.
 */
export function validateRules(rules: ScheduleRules): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = rules.name.trim();
  if (name.length < 2) errors.name = 'Give the schedule a name.';
  else if (name.length > SCHEDULE_NAME_MAX) errors.name = `Keep the name to ${SCHEDULE_NAME_MAX} characters or fewer.`;
  if (rules.kind !== 'fixed' && rules.kind !== 'flexible') errors.kind = 'Choose fixed or flexible hours.';
  if (!isTimeZone(rules.timeZone)) errors.timeZone = 'Choose a time zone from the list, for example Asia/Kolkata.';
  if (errors.kind) return errors;
  const fixed = rules.kind === 'fixed';

  if (!['none', 'fixed', 'tracked'].includes(rules.break.mode)) errors['break.mode'] = 'Choose how breaks are handled.';
  else if (rules.break.mode !== 'none') {
    if (!isWholeNumber(rules.break.minutes, rules.break.mode === 'fixed' ? 1 : 0, 480)) errors['break.minutes'] = rules.break.mode === 'fixed' ? 'Enter the length of the break, up to 8 hours.' : 'Enter the least break to take off, or 0, up to 8 hours.';
    if (!isWholeNumber(rules.break.appliesAfter, 0, DAY_MINUTES)) errors['break.appliesAfter'] = 'Enter after how long a day the break is taken off, or 0.';
  }
  const breakRule: BreakRule = errors['break.mode'] || errors['break.minutes'] ? { mode: 'none', minutes: 0, appliesAfter: 0 } : rules.break;

  validateHours(rules.kind, rules.standard, breakRule, 'standard', errors);
  let working = 0;
  let longest = 0;
  for (const day of WEEKDAYS) {
    const rule = rules.days[day];
    if (rule === 'off') continue;
    working += 1;
    if (rule !== 'standard') {
      if (typeof rule !== 'object' || rule === null) {
        errors[`days.${day}`] = 'Choose off, the standard hours, or hours of its own.';
        continue;
      }
      validateHours(rules.kind, rule, breakRule, `days.${day}`, errors);
    }
    const hours = rule === 'standard' ? rules.standard : rule;
    // A day whose own times are wrong says so beside them; it must not also set off the checks that depend on its length.
    const at = rule === 'standard' ? 'standard' : `days.${day}`;
    if (errors[`${at}.start`] || errors[`${at}.end`] || errors[`${at}.requiredMinutes`]) continue;
    longest = Math.max(longest, fixed ? spanMinutes(hours) : hours.requiredMinutes);
  }
  if (working === 0) errors.days = 'At least one day of the week must be a working day.';

  if (fixed) {
    if (!isWholeNumber(rules.lateGraceMinutes, 0, 240)) errors.lateGraceMinutes = 'Enter the grace in minutes, from 0 to 240.';
    if (!isWholeNumber(rules.earlyCheckInMinutes, 0, 720)) errors.earlyCheckInMinutes = 'Enter how early check-in opens, from 0 to 12 hours.';
    // Check-in for a day must not open while the day before can still be running, with an hour to check out in.
    else if (longest > 0 && rules.earlyCheckInMinutes + longest + 60 > DAY_MINUTES) {
      errors.earlyCheckInMinutes = `With a ${formatMinutes(longest)} day, check-in can open at most ${formatMinutes(Math.max(0, DAY_MINUTES - longest - 60))} before the start.`;
    }
    if (typeof rules.earlyLeave.tracked !== 'boolean') errors['earlyLeave.tracked'] = 'Choose whether early departures are marked.';
    if (!isWholeNumber(rules.earlyLeave.graceMinutes, 0, 240)) errors['earlyLeave.graceMinutes'] = 'Enter the grace in minutes, from 0 to 240.';
  } else {
    if (rules.lateGraceMinutes !== 0) errors.lateGraceMinutes = 'A flexible schedule has no start time, so there is no late grace.';
    if (rules.earlyCheckInMinutes !== 0) errors.earlyCheckInMinutes = 'A flexible schedule has no start time, so check-in is open all day.';
    if (rules.earlyLeave.tracked !== false) errors['earlyLeave.tracked'] = 'A flexible schedule has no end time, so early departures cannot be marked.';
  }

  if (!isWholeNumber(rules.missingCheckOut.closeAfterMinutes, 60, DAY_MINUTES)) errors['missingCheckOut.closeAfterMinutes'] = 'Enter a time from 1 to 24 hours.';
  else if (rules.missingCheckOut.closeAfterMinutes < longest) {
    errors['missingCheckOut.closeAfterMinutes'] = `This must be at least as long as the longest day (${formatMinutes(longest)}), or nobody could check out at its end.`;
  }
  if (!['unresolved', 'half_day', 'absent'].includes(rules.missingCheckOut.countsAs)) errors['missingCheckOut.countsAs'] = 'Choose how a day without a check-out is counted.';
  if (rules.offDayWork !== 'allowed' && rules.offDayWork !== 'blocked') errors.offDayWork = 'Choose whether checking in on a day off is allowed.';
  if (!isWholeNumber(rules.corrections.windowDays, 0, 90)) errors['corrections.windowDays'] = 'Enter a number of days from 0 to 90.';
  if (rules.corrections.maxPerMonth !== null && !isWholeNumber(rules.corrections.maxPerMonth, 1, 31)) errors['corrections.maxPerMonth'] = 'Enter a number from 1 to 31, or leave it without a limit.';
  return errors;
}

/** The rules as they are stored: the name trimmed, and fields that mean nothing for the kind or break mode set to their neutral values. */
export function tidyRules(rules: ScheduleRules): ScheduleRules {
  const fixed = rules.kind === 'fixed';
  const hours = (h: DayHours): DayHours => ({ start: fixed ? h.start : null, end: fixed ? h.end : null, requiredMinutes: h.requiredMinutes, fullDayMinutes: h.fullDayMinutes, halfDayMinutes: h.halfDayMinutes });
  const days = {} as Record<Weekday, DayRule>;
  for (const day of WEEKDAYS) {
    const rule = rules.days[day];
    days[day] = rule === 'off' || rule === 'standard' ? rule : hours(rule);
  }
  return {
    name: rules.name.trim(),
    kind: rules.kind,
    timeZone: rules.timeZone.trim(),
    standard: hours(rules.standard),
    days,
    break: rules.break.mode === 'none' ? { mode: 'none', minutes: 0, appliesAfter: 0 } : { mode: rules.break.mode, minutes: rules.break.minutes, appliesAfter: rules.break.appliesAfter },
    lateGraceMinutes: fixed ? rules.lateGraceMinutes : 0,
    earlyCheckInMinutes: fixed ? rules.earlyCheckInMinutes : 0,
    earlyLeave: fixed ? { tracked: rules.earlyLeave.tracked, graceMinutes: rules.earlyLeave.tracked ? rules.earlyLeave.graceMinutes : 0 } : { tracked: false, graceMinutes: 0 },
    missingCheckOut: { closeAfterMinutes: rules.missingCheckOut.closeAfterMinutes, countsAs: rules.missingCheckOut.countsAs },
    offDayWork: rules.offDayWork,
    corrections: { windowDays: rules.corrections.windowDays, maxPerMonth: rules.corrections.maxPerMonth },
  };
}

/** "Monday to Friday", "Monday, Wednesday and Friday", "Saturday". */
export function dayList(days: readonly Weekday[]): string {
  const ordered = WEEKDAYS.filter((d) => days.includes(d));
  if (ordered.length === 0) return 'no day';
  if (ordered.length === 7) return 'every day';
  // One unbroken run of three or more reads best as a range. The week goes round, so a run may
  // start after a day that is not in the list: everything but Friday is "Saturday to Thursday".
  if (ordered.length >= 3) {
    const starts = ordered.filter((d) => !ordered.includes(WEEKDAYS[(WEEKDAYS.indexOf(d) + 6) % 7]!));
    if (starts.length === 1) {
      const from = WEEKDAYS.indexOf(starts[0]!);
      return `${WEEKDAY_NAMES[WEEKDAYS[from]!]} to ${WEEKDAY_NAMES[WEEKDAYS[(from + ordered.length - 1) % 7]!]}`;
    }
  }
  const names = ordered.map((d) => WEEKDAY_NAMES[d]);
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const hoursText = (kind: ScheduleKind, h: DayHours) => (kind === 'fixed' ? `${h.start} to ${h.end}` : `any hours, ${formatMinutes(h.requiredMinutes)} expected`);

/** One line of the plain-words summary. `warn` marks a consequence the person setting the rules probably did not intend. */
export interface RuleLine {
  text: string;
  warn?: boolean;
}

/**
 * What a set of rules means, in sentences. Shown beside the form while HR edits a schedule and
 * on an employee's page, so nobody has to work out what the numbers do.
 */
export function describeRules(rules: ScheduleRules): RuleLine[] {
  const lines: RuleLine[] = [];
  const fixed = rules.kind === 'fixed';
  const std = rules.standard;
  const standardDays = WEEKDAYS.filter((d) => rules.days[d] === 'standard');
  const ownDays = WEEKDAYS.filter((d) => typeof rules.days[d] === 'object');
  const offDays = WEEKDAYS.filter((d) => rules.days[d] === 'off');

  if (standardDays.length > 0) lines.push({ text: `Works ${dayList(standardDays)}, ${hoursText(rules.kind, std)}, on ${rules.timeZone} time.` });
  for (const day of ownDays) {
    const h = rules.days[day] as DayHours;
    lines.push({ text: `${WEEKDAY_NAMES[day]} is different: ${hoursText(rules.kind, h)}${fixed ? `, ${formatMinutes(h.requiredMinutes)} expected` : ''}.` });
  }
  if (standardDays.length === 0 && ownDays.length > 0) lines.push({ text: `Times are on ${rules.timeZone} time.` });
  lines.push({ text: offDays.length === 0 ? 'No weekly day off.' : `Off on ${dayList(offDays)}.` });

  const reference = standardDays.length > 0 ? std : ownDays.length > 0 ? (rules.days[ownDays[0]!] as DayHours) : std;
  if (fixed && reference.start && reference.end) {
    if (workingDays(rules).some((d) => isOvernight(hoursFor(rules, d)!))) lines.push({ text: 'The shift runs past midnight. The whole of it counts for the day it starts on.' });
    lines.push({
      text:
        rules.lateGraceMinutes > 0
          ? `Arriving up to ${shiftTime(reference.start, rules.lateGraceMinutes)} is on time. From ${shiftTime(reference.start, rules.lateGraceMinutes + 1)} it is a late entry.`
          : `Arriving after ${reference.start} is a late entry.`,
    });
    lines.push({ text: rules.earlyCheckInMinutes > 0 ? `Check-in opens at ${shiftTime(reference.start, -rules.earlyCheckInMinutes)}, ${formatMinutes(rules.earlyCheckInMinutes)} before the start.` : `Check-in opens at ${reference.start}, not before.` });
  }

  lines.push({
    text: `A full day needs ${formatMinutes(reference.fullDayMinutes)} of work and half a day ${formatMinutes(reference.halfDayMinutes)}. Less than ${formatMinutes(reference.halfDayMinutes)} does not count as a day.`,
  });

  const after = rules.break.appliesAfter > 0 ? `, once the day goes beyond ${formatMinutes(rules.break.appliesAfter)}` : '';
  if (rules.break.mode === 'none') lines.push({ text: 'No break is taken off the time worked.' });
  else if (rules.break.mode === 'fixed') lines.push({ text: `Break: ${formatMinutes(rules.break.minutes)} is taken off the time worked${after}.` });
  else lines.push({ text: rules.break.minutes > 0 ? `Breaks are recorded with the Break button and taken off as taken: at least ${formatMinutes(rules.break.minutes)}${after}.` : 'Breaks are recorded with the Break button and taken off the time worked.' });

  if (fixed && reference.start && reference.end) {
    // The commonest day: in at the last on-time minute, out at the end.
    const gross = spanMinutes(reference) - rules.lateGraceMinutes;
    const worked = gross - breakDeducted(rules.break, gross);
    const arrive = shiftTime(reference.start, rules.lateGraceMinutes);
    if (worked >= reference.fullDayMinutes) lines.push({ text: `Arriving at ${arrive} and leaving at ${reference.end} is ${formatMinutes(worked)} of work: a full day.` });
    else {
      lines.push({
        text: `Arriving at ${arrive} (on time) and leaving at ${reference.end} is ${formatMinutes(worked)} of work: ${worked >= reference.halfDayMinutes ? 'only half a day' : 'not counted as a day'}. Lower the full-day threshold or the grace if that is not what you mean.`,
        warn: true,
      });
    }
    if (rules.earlyLeave.tracked) {
      lines.push({ text: rules.earlyLeave.graceMinutes > 0 ? `Leaving more than ${formatMinutes(rules.earlyLeave.graceMinutes)} before ${reference.end} is marked as an early departure.` : `Leaving before ${reference.end} is marked as an early departure.` });
    }
  }

  const counted: Record<MissingCheckOut, string> = { unresolved: 'it is unresolved until it is corrected', half_day: 'it is counted as half a day', absent: 'it is counted as absent' };
  const until = fixed ? ', or until check-in opens for the next working day' : ', or until midnight, when a flexible day ends';
  lines.push({ text: `A day with no check-out can still be closed for ${formatMinutes(rules.missingCheckOut.closeAfterMinutes)} after check-in${until}. After that ${counted[rules.missingCheckOut.countsAs]}.` });
  lines.push({ text: rules.offDayWork === 'allowed' ? 'Checking in on a day off or a holiday is allowed.' : 'Checking in on a day off or a holiday is not allowed.' });
  lines.push({
    text:
      rules.corrections.windowDays === 0
        ? 'Employees cannot ask for attendance corrections themselves.'
        : `Employees can ask for a correction up to ${rules.corrections.windowDays} ${rules.corrections.windowDays === 1 ? 'day' : 'days'} back${rules.corrections.maxPerMonth === null ? '' : `, at most ${rules.corrections.maxPerMonth} a month`}.`,
  });
  return lines;
}

/** A one-line summary for lists: "09:00 to 18:00 · Monday to Friday". */
export function rulesHeadline(rules: ScheduleRules): string {
  const days = dayList(workingDays(rules));
  return rules.kind === 'fixed' ? `${rules.standard.start} to ${rules.standard.end} · ${days}` : `Flexible, ${formatMinutes(rules.standard.requiredMinutes)} a day · ${days}`;
}

/**
 * The assignment in force on a date: the latest one that starts on or before it. Null before
 * the first one starts. This is the only way "the rules on date D" are ever found.
 */
export function assignmentOn<T extends { effectiveFrom: LocalDate }>(assignments: readonly T[], date: LocalDate): T | null {
  let found: T | null = null;
  for (const a of assignments) {
    if (a.effectiveFrom <= date && (!found || a.effectiveFrom > found.effectiveFrom)) found = a;
  }
  return found;
}

/**
 * Why an assignment cannot start on a date, or null when it can (plan.md, 6.2). Nothing is
 * back-dated: a person's first assignment starts today at the earliest, and every later one
 * tomorrow at the earliest, so the rules never change under a day that has already begun.
 *
 * `today` is today's date for that employee: in the zone of the rules they work under now,
 * or, when they have none yet, of the rules being assigned.
 */
export function startBlocker(effectiveFrom: LocalDate, today: LocalDate, hasAssignment: boolean): string | null {
  if (!isLocalDate(effectiveFrom)) return 'Choose the date the schedule starts.';
  if (hasAssignment && effectiveFrom <= today) return 'A change of schedule can start tomorrow at the earliest, so the rules never change under a day that has begun.';
  if (!hasAssignment && effectiveFrom < today) return 'A first schedule can start today at the earliest. Nothing is back-dated.';
  if (effectiveFrom > addDays(today, 366)) return 'Choose a start date within the next year.';
  return null;
}
