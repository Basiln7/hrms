/*
 * The overview of a day, attendance records and reports (plan.md, sections 6.5 and 11).
 *
 * Nothing here judges a day: that is the engine's work, once (attendance.ts). These are the
 * ways of looking at many days at a time. They sort days the engine has already read into
 * groups, pick the ones a filter asks for, add them up, and write them out as rows. So a
 * number on the overview, a row in a report and a cell in a CSV file can never disagree with
 * the calendar, which reads the same days with the same function.
 */
import { STATUS_LABEL, summarize, type DayFlag, type DayResult, type DayStatus, type PeriodSummary } from './attendance';
import type { CsvCell } from './csv';
import { localParts, WEEKDAY_NAMES, weekdayOf } from './dates';
import { flagWords } from './today';

// ── The overview of one day ─────────────────────────────────────────────────

/**
 * Every person falls into exactly one of these on a given day. They are the engine's
 * statuses, a few of them taken together: "absent" is everyone the day counts as absent and
 * everyone who should have come in by now and has not (plan.md, 6.5).
 */
export const OVERVIEW_GROUPS = ['working', 'present', 'half_day', 'absent', 'unresolved', 'leave', 'day_off', 'not_due', 'upcoming', 'not_counted'] as const;
export type OverviewGroup = (typeof OVERVIEW_GROUPS)[number];

const GROUP_OF: Record<DayStatus, OverviewGroup> = {
  working: 'working',
  on_break: 'working',
  present: 'present',
  half_day: 'half_day',
  absent: 'absent',
  not_in: 'absent',
  unresolved: 'unresolved',
  leave: 'leave',
  holiday: 'day_off',
  weekly_off: 'day_off',
  not_due: 'not_due',
  upcoming: 'upcoming',
  not_applicable: 'not_counted',
};

export const overviewGroupOf = (day: Pick<DayResult, 'status'>): OverviewGroup => GROUP_OF[day.status];

/** What the overview can be narrowed to: one group, or one of two things that cut across them. */
export type OverviewFilter = OverviewGroup | 'all' | 'checked_in' | 'late';
export const OVERVIEW_FILTERS: readonly OverviewFilter[] = ['all', 'checked_in', 'late', ...OVERVIEW_GROUPS];

export const OVERVIEW_INFO: Record<OverviewFilter, { label: string; hint: string }> = {
  all: { label: 'Employees', hint: 'Everyone in view who is not deactivated.' },
  checked_in: { label: 'Checked in', hint: 'Anyone with a check-in for this day, whatever the day counts as.' },
  late: { label: 'Late', hint: 'Checked in after the grace their schedule allows.' },
  working: { label: 'Working now', hint: 'Checked in and not yet out, or on a break.' },
  present: { label: 'Present', hint: 'Checked out with a full day.' },
  half_day: { label: 'Half-day', hint: 'The day counts as half.' },
  absent: { label: 'Absent', hint: 'Not in when they should be, or a day that counts as absent.' },
  unresolved: { label: 'Unresolved', hint: 'A check-in with no check-out, not yet corrected.' },
  leave: { label: 'On leave', hint: 'Approved leave for the whole day.' },
  day_off: { label: 'Day off', hint: 'Their weekly off, or a holiday on their calendar.' },
  not_due: { label: 'Not due yet', hint: 'Their day has not started, or is still within its grace.' },
  upcoming: { label: 'To come', hint: 'A working day that has not begun.' },
  not_counted: { label: 'Not counted', hint: 'No work schedule on this day, or outside their employment.' },
};

export function inOverview(day: Pick<DayResult, 'status' | 'flags' | 'checkInAt'>, filter: OverviewFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'checked_in') return day.checkInAt !== null;
  if (filter === 'late') return day.flags.includes('late');
  return overviewGroupOf(day) === filter;
}

export type OverviewCounts = Record<OverviewFilter, number>;

/** How many people are in each group, one day per person. The groups add up to everyone. */
export function countOverview(days: readonly Pick<DayResult, 'status' | 'flags' | 'checkInAt'>[]): OverviewCounts {
  const counts = Object.fromEntries(OVERVIEW_FILTERS.map((filter) => [filter, 0])) as OverviewCounts;
  for (const day of days) for (const filter of OVERVIEW_FILTERS) if (inOverview(day, filter)) counts[filter] += 1;
  return counts;
}

// ── Attendance records ──────────────────────────────────────────────────────

/** The statuses records can be narrowed to. "Working" takes in a break. */
export const RECORD_STATUSES = ['present', 'half_day', 'absent', 'leave', 'unresolved', 'working', 'not_in', 'holiday', 'weekly_off'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** The marks records can be narrowed to. */
export const RECORD_FLAGS: readonly DayFlag[] = ['late', 'late_excused', 'early_departure', 'short_hours', 'missing_check_out', 'corrected', 'pending_correction', 'pending_leave', 'half_day_leave', 'worked_on_off_day', 'worked_on_leave'];

export interface RecordFilter {
  status?: RecordStatus;
  flag?: DayFlag;
}

/**
 * Whether a day belongs in the records, with or without a filter. Without one, the list is
 * every day there is something to say about: not a day still to come, not a day that does
 * not count for the person, and not a day off on which nothing happened. Asking for days off
 * by name lists them.
 */
export function inRecords(day: DayResult, filter: RecordFilter = {}): boolean {
  if (day.status === 'not_applicable' || day.status === 'upcoming') return false;
  if (filter.flag && !day.flags.includes(filter.flag)) return false;
  if (filter.status) return filter.status === 'working' ? day.status === 'working' || day.status === 'on_break' : day.status === filter.status;
  return day.kind === 'working' || day.checkInAt !== null;
}

export interface LateCount {
  /** Days with a late entry, excused ones included. */
  entries: number;
  /** How many of those were explained and accepted. */
  excused: number;
  /** Minutes late, added up. */
  minutes: number;
}

/** How often, and by how much, someone was late over some days. */
export function lateCount(days: readonly Pick<DayResult, 'flags' | 'lateMinutes'>[]): LateCount {
  const late = days.filter((day) => day.flags.includes('late'));
  return { entries: late.length, excused: late.filter((day) => day.flags.includes('late_excused')).length, minutes: late.reduce((sum, day) => sum + day.lateMinutes, 0) };
}

// ── Reports as rows ─────────────────────────────────────────────────────────

/** Minutes as hours with two decimals: what a spreadsheet can add up. */
export const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

/** The totals of several people's summaries, field by field. */
export function addSummaries(summaries: readonly PeriodSummary[]): PeriodSummary {
  const total = summarize([]);
  for (const summary of summaries) for (const key of Object.keys(total) as (keyof PeriodSummary)[]) total[key] += summary[key];
  return total;
}

export interface PersonCells {
  code: string;
  name: string;
  departmentName: string | null;
}

const SUMMARY_HEADINGS = ['Working days counted', 'Present', 'Half-days', 'Leave', 'Of which unpaid leave', 'Absent', 'Unresolved', 'Late entries', 'Early departures', 'Corrected days', 'Holidays', 'Weekly offs', 'Days off worked', 'Hours worked'] as const;

const summaryCells = (s: PeriodSummary): CsvCell[] => [s.workingDays, s.presentDays, s.halfDays, s.leaveDays, s.unpaidLeaveDays, s.absentDays, s.unresolvedDays, s.lateEntries, s.earlyDepartures, s.correctedDays, s.holidays, s.weeklyOffs, s.offDaysWorked, hoursOf(s.workedMinutes)];

/** The monthly summary as rows: a heading, one row per person, and the totals. */
export function monthlyRows(rows: readonly (PersonCells & { summary: PeriodSummary })[], totals: PeriodSummary): CsvCell[][] {
  return [
    ['Employee code', 'Name', 'Department', ...SUMMARY_HEADINGS],
    ...rows.map((row) => [row.code, row.name, row.departmentName ?? '', ...summaryCells(row.summary)]),
    ['', 'Total', '', ...summaryCells(totals)],
  ];
}

/** A moment as the clock in a zone showed it, with the date when it is not on the day itself (a night shift's check-out). */
function clockOn(moment: string | null, date: string, timeZone: string): string {
  if (!moment) return '';
  const parts = localParts(moment, timeZone);
  return parts.date === date ? parts.time : `${parts.time} (${parts.date})`;
}

const DAY_HEADINGS = ['Date', 'Day', 'Status', 'Notes', 'Check-in', 'Check-out', 'Break (minutes)', 'Worked (hours)', 'Late by (minutes)', 'Left early by (minutes)', 'Holiday', 'Leave'] as const;

/** One day as cells. Its times are on the clock of the zone the day is judged in. */
function dayCells(day: DayResult, timeZone: string): CsvCell[] {
  const counted = day.checkOutAt !== null;
  return [
    day.date,
    WEEKDAY_NAMES[weekdayOf(day.date)],
    STATUS_LABEL[day.status],
    flagWords(day)
      .map((word) => word.text)
      .join('; '),
    clockOn(day.checkInAt, day.date, timeZone),
    clockOn(day.checkOutAt, day.date, timeZone),
    counted ? day.breakMinutes : '',
    counted ? hoursOf(day.workedMinutes) : '',
    day.lateMinutes > 0 ? day.lateMinutes : '',
    day.earlyMinutes > 0 ? day.earlyMinutes : '',
    day.holiday?.name ?? '',
    day.leave?.name ?? '',
  ];
}

/** One person's days as rows: a heading and a row per day. */
export function employeeRows(days: readonly DayResult[], timeZone: string): CsvCell[][] {
  return [[...DAY_HEADINGS], ...days.map((day) => dayCells(day, timeZone))];
}

/** Many people's days as rows: who, then the day. */
export function recordRows(rows: readonly (PersonCells & { timeZone: string; day: DayResult })[]): CsvCell[][] {
  return [['Employee code', 'Name', 'Department', ...DAY_HEADINGS], ...rows.map((row) => [row.code, row.name, row.departmentName ?? '', ...dayCells(row.day, row.timeZone)])];
}
