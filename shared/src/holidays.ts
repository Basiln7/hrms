/*
 * Holidays (plan.md, section 9).
 *
 * A holiday calendar is a named set of dated holidays. An employee is on a calendar through
 * their schedule assignment, so the choice is dated exactly like the schedule: which calendar
 * applied on a date is frozen in the assignment that was in force then, and giving someone a
 * different calendar can only start on a day that has not begun.
 *
 * What a holiday does to a day is the attendance engine's business (attendance.ts). This file
 * is about the calendars themselves: what a sound holiday is, which holidays are one person's,
 * and how to say what changing one would do to days that have already begun.
 */
import { STATUS_LABEL, type DayStatus, type HolidayOnDay, type HolidayType } from './attendance';
import { dayInWords, isLocalDate, type LocalDate } from './dates';
import { touchedInWords, type LeaveTouched } from './leave';
import { assignmentOn } from './schedules';

export const HOLIDAY_TYPES: readonly HolidayType[] = ['public', 'company', 'optional', 'special_working_day'];

/** The four kinds, in words. `dayOff` says whether the kind makes the date a day off. */
export const HOLIDAY_TYPE_INFO: Record<HolidayType, { label: string; hint: string; dayOff: boolean }> = {
  public: { label: 'Public holiday', hint: 'A day off for everyone on this calendar.', dayOff: true },
  company: { label: 'Company holiday', hint: 'A day off the company gives.', dayOff: true },
  optional: { label: 'Optional holiday', hint: 'Shown on the calendar, but still a working day. Someone who wants it off takes leave.', dayOff: false },
  special_working_day: { label: 'Special working day', hint: 'A day that is normally off and is worked this once, on the normal hours.', dayOff: false },
};

export interface HolidayCalendar {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Holiday {
  id: string;
  calendarId: string;
  date: LocalDate;
  name: string;
  type: HolidayType;
  description: string;
  createdBy: string;
  /** A snapshot, so the record still reads after a rename. */
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/** What HR fills in for a holiday. */
export interface HolidayInput {
  date: LocalDate;
  name: string;
  type: HolidayType;
  description: string;
}

export const CALENDAR_NAME_MAX = 60;
export const HOLIDAY_NAME_MAX = 80;
export const HOLIDAY_DESCRIPTION_MAX = 300;
/** Holidays are kept for these years. Outside them a date is far more likely a slip of the keyboard than a plan. */
export const HOLIDAY_YEAR_MIN = 2000;
export const HOLIDAY_YEAR_MAX = 2100;

export const isHolidayYear = (year: unknown): year is number => typeof year === 'number' && Number.isInteger(year) && year >= HOLIDAY_YEAR_MIN && year <= HOLIDAY_YEAR_MAX;

/** What is wrong with a calendar's name, or null. */
export function calendarNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return 'Give the calendar a name.';
  if (trimmed.length > CALENDAR_NAME_MAX) return `Keep this to ${CALENDAR_NAME_MAX} characters or fewer.`;
  return null;
}

/** Field-by-field problems with a holiday; empty when it is fine. */
export function validateHoliday(input: HolidayInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!isLocalDate(input.date)) errors.date = 'Choose the date of the holiday.';
  else if (!isHolidayYear(Number(input.date.slice(0, 4)))) errors.date = `Choose a date between ${HOLIDAY_YEAR_MIN} and ${HOLIDAY_YEAR_MAX}.`;
  const name = input.name.trim();
  if (name.length < 2) errors.name = 'Give the holiday a name.';
  else if (name.length > HOLIDAY_NAME_MAX) errors.name = `Keep this to ${HOLIDAY_NAME_MAX} characters or fewer.`;
  if (!HOLIDAY_TYPES.includes(input.type)) errors.type = 'Choose what kind of day it is.';
  if (input.description.trim().length > HOLIDAY_DESCRIPTION_MAX) errors.description = `Keep this to ${HOLIDAY_DESCRIPTION_MAX} characters or fewer.`;
  return errors;
}

type DatedCalendar = { effectiveFrom: LocalDate; holidayCalendarId: string | null };
type HolidayFact = Pick<Holiday, 'calendarId' | 'date' | 'name' | 'type'>;

/**
 * The holiday, if any, on a date for someone: the one on the calendar named by the assignment
 * that was in force on that date. This is the engine's `holidayOn`.
 */
export function holidayLookup(assignments: readonly DatedCalendar[], holidays: readonly HolidayFact[]): (date: LocalDate) => HolidayOnDay | null {
  const byDay = new Map(holidays.map((h) => [`${h.calendarId}|${h.date}`, h]));
  return (date) => {
    const calendarId = assignmentOn(assignments, date)?.holidayCalendarId;
    const found = calendarId ? byDay.get(`${calendarId}|${date}`) : undefined;
    return found ? { name: found.name, type: found.type } : null;
  };
}

/**
 * One person's holidays between two dates, in order. Someone who changed calendars part of
 * the way through gets each date from the calendar they were on then.
 */
export function holidaysFor<T extends HolidayFact>(assignments: readonly DatedCalendar[], holidays: readonly T[], from: LocalDate, to: LocalDate): T[] {
  return holidays.filter((h) => h.date >= from && h.date <= to && assignmentOn(assignments, h.date)?.holidayCalendarId === h.calendarId).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** A change of calendar starts on a day that has not begun, for the same reason a change of schedule does. */
export function calendarStartBlocker(effectiveFrom: LocalDate, today: LocalDate): string | null {
  if (!isLocalDate(effectiveFrom)) return 'Choose the date the calendar starts.';
  if (effectiveFrom <= today) return 'A change of holiday calendar can start tomorrow at the earliest, so no day that has begun changes.';
  return null;
}

export interface YearCopy {
  copy: HolidayInput[];
  skipped: { date: LocalDate; name: string; reason: string }[];
}

/**
 * A year's holidays moved to another year, date for date, for HR to review. A date that does
 * not exist there (29 February), one that already has a holiday, and one that has already
 * begun are left out, each with its reason. Holidays whose date moves from year to year are
 * copied like the rest: they are the ones to check.
 *
 * @param taken   the dates that already hold a holiday in the target year
 * @param notAfter dates up to and including this one have begun and are not written by a copy
 */
export function copyYear(holidays: readonly HolidayInput[], toYear: number, taken: ReadonlySet<LocalDate>, notAfter: LocalDate): YearCopy {
  const result: YearCopy = { copy: [], skipped: [] };
  for (const holiday of [...holidays].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const date = `${String(toYear).padStart(4, '0')}${holiday.date.slice(4)}`;
    const skip = (reason: string) => result.skipped.push({ date, name: holiday.name, reason });
    if (!isLocalDate(date)) skip(`${Number(holiday.date.slice(8, 10))} February does not exist in ${toYear}.`);
    else if (taken.has(date)) skip('That date already has a holiday.');
    else if (date <= notAfter) skip('That date has already begun. Add it by hand, so that what it changes is shown first.');
    else result.copy.push({ date, name: holiday.name, type: holiday.type, description: holiday.description });
  }
  return result;
}

/**
 * What adding, changing or removing a holiday does that HR should see first: how days that
 * have already begun would read afterwards, and which leave requests include the date (their
 * days were counted with the calendar as it was). Empty when it does neither.
 */
export interface HolidayEffect {
  /** People with at least one day that would read differently. */
  people: number;
  changes: { date: LocalDate; from: DayStatus; to: DayStatus; count: number }[];
  /** Leave requests, waiting or approved, that include one of the dates, for people on the calendar then. */
  leave?: LeaveTouched[];
}

export const hasEffect = (effect: HolidayEffect) => effect.changes.length > 0 || (effect.leave?.length ?? 0) > 0;

/** The effect in sentences, for the confirmation HR reads before making the change. */
export function effectInWords(effect: HolidayEffect): string[] {
  const lines: string[] = [];
  if (effect.changes.length > 0) lines.push(`This changes days that have already begun, for ${effect.people} ${effect.people === 1 ? 'person' : 'people'}.`);
  for (const change of effect.changes) {
    const one = change.count === 1;
    lines.push(`${dayInWords(change.date)}: ${change.count} ${one ? 'day that reads' : 'days that read'} ${STATUS_LABEL[change.from]} will read ${STATUS_LABEL[change.to]}.`);
  }
  return [...lines, ...touchedInWords(effect.leave ?? [])];
}
