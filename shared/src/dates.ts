/*
 * Days and moments.
 *
 * A moment is a point in time, stored in UTC. A day ('YYYY-MM-DD') is a local idea: it only
 * means something together with a time zone. Everything here takes the zone as an argument
 * and never looks at the time zone of the machine it runs on, so the answer is the same on a
 * server in any country. Plain date arithmetic is done on UTC fields for the same reason.
 */

/** A calendar day, 'YYYY-MM-DD'. */
export type LocalDate = string;
/** A wall-clock time, 'HH:mm', 24-hour. */
export type LocalTime = string;
/** A moment, in any of the forms the app passes around. */
export type Instant = Date | number | string;

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Monday first, the order used for a week's schedule. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ZONE_PATTERN = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;

const pad = (value: number, width = 2) => String(value).padStart(width, '0');
const toMs = (instant: Instant) => (instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant));

/** Whether the text is a real calendar day (so not 2026-02-30). */
export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const isLocalTime = (value: unknown): value is LocalTime => typeof value === 'string' && TIME_PATTERN.test(value);

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether the name is an IANA time zone this platform knows, e.g. "Asia/Kolkata". Offsets like "+05:30" are not accepted. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !ZONE_PATTERN.test(value)) return false;
  try {
    formatterFor(value);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  date: LocalDate;
  time: LocalTime;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

const assertDate = (date: LocalDate) => {
  if (!isLocalDate(date)) throw new RangeError(`Not a calendar day: ${String(date)}`);
};

const utcMsOf = (date: LocalDate) => {
  assertDate(date);
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
};

/** The day of the week a calendar day falls on. */
export function weekdayOf(date: LocalDate): Weekday {
  // getUTCDay: 0 is Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(utcMsOf(date)).getUTCDay() + 6) % 7]!;
}

/**
 * The last answer per zone. A report reads thousands of days at one "now", and asks what the
 * clock shows at that same moment for each of them.
 */
const lastParts = new Map<string, { ms: number; parts: LocalParts }>();

/** What the clock on the wall shows in a time zone at a moment. */
export function localParts(instant: Instant, timeZone: string): LocalParts {
  const ms = toMs(instant);
  if (Number.isNaN(ms)) throw new RangeError('Not a valid moment.');
  const last = lastParts.get(timeZone);
  if (last?.ms === ms) return { ...last.parts };
  const found: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') found[part.type] = Number(part.value);
  }
  const { year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0 } = found;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  const parts: LocalParts = { date, time: `${pad(hour)}:${pad(minute)}`, year, month, day, hour, minute, second, weekday: weekdayOf(date) };
  lastParts.set(timeZone, { ms, parts });
  return { ...parts };
}

/** The calendar day it is in a time zone at a moment. */
export const localDateOf = (instant: Instant, timeZone: string): LocalDate => localParts(instant, timeZone).date;

/** How far the zone's wall clock is ahead of UTC at a moment, in minutes (India: 330). */
export function offsetMinutes(instant: Instant, timeZone: string): number {
  const ms = toMs(instant);
  const p = localParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/**
 * The moment at which the wall clock in a time zone shows a given day and time.
 *
 * Where clocks change, a wall time can be missing or happen twice. A time that does not exist
 * (clocks went forward over it) is moved forward by the size of the jump. A time that happens
 * twice (clocks went back) is taken as the first of the two.
 */
export function zonedToInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  if (!isLocalTime(time)) throw new RangeError(`Not a time of day: ${String(time)}`);
  // The answer depends on nothing but the three arguments, and the same shift times on the
  // same dates are asked for once per person in every report: remember them.
  const key = `${timeZone}|${date}|${time}`;
  const known = instants.get(key);
  if (known !== undefined) return new Date(known);
  const moment = wallToInstant(date, time, timeZone);
  if (instants.size >= INSTANTS_KEPT) instants.clear();
  instants.set(key, moment.getTime());
  return moment;
}

const instants = new Map<string, number>();
/** Past this many the memory is simply emptied: it is a convenience, not a record. */
const INSTANTS_KEPT = 20_000;

function wallToInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  // The wall time as if it were UTC. The real moment is within 14 hours of this either way,
  // so the offsets in force around it are the only two the answer can use.
  const wall = utcMsOf(date) + Number(time.slice(0, 2)) * HOUR + Number(time.slice(3, 5)) * MINUTE;
  const before = offsetMinutes(wall - 14 * HOUR, timeZone);
  const after = offsetMinutes(wall + 14 * HOUR, timeZone);
  const first = wall - before * MINUTE;
  const second = wall - after * MINUTE;
  if (before === after) return new Date(first);

  // A candidate is real when the zone's offset at that moment is the one it was worked out with.
  const firstIsReal = offsetMinutes(first, timeZone) === before;
  const secondIsReal = offsetMinutes(second, timeZone) === after;
  if (firstIsReal && secondIsReal) return new Date(Math.min(first, second));
  if (firstIsReal) return new Date(first);
  if (secondIsReal) return new Date(second);
  return new Date(Math.max(first, second));
}

/** The first moment of a calendar day in a time zone. */
export const startOfDay = (date: LocalDate, timeZone: string): Date => zonedToInstant(date, '00:00', timeZone);

/** The calendar day `days` after (or, when negative, before) another. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(utcMsOf(date) + days * DAY);
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** How many days `to` is after `from` (negative when it is before). */
export const daysBetween = (from: LocalDate, to: LocalDate): number => Math.round((utcMsOf(to) - utcMsOf(from)) / DAY);

/** A moment with its seconds dropped: 09:10:59 is 09:10. Attendance is worked out in whole minutes. */
export const truncateToMinute = (instant: Instant): Date => new Date(Math.floor(toMs(instant) / MINUTE) * MINUTE);

/** Whole minutes from one moment to another, each first cut to the minute. */
export const minutesBetween = (from: Instant, to: Instant): number => (truncateToMinute(to).getTime() - truncateToMinute(from).getTime()) / MINUTE;

/** A calendar day in words, without the year: "Monday 7 December". */
export function dayInWords(date: LocalDate): string {
  return `${WEEKDAY_NAMES[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;
}

/** A day and a time on the wall clock of some zone, 'YYYY-MM-DDTHH:mm': what a date-and-time field in a form holds. */
export type LocalDateTime = string;

export const isLocalDateTime = (value: unknown): value is LocalDateTime => typeof value === 'string' && value.length === 16 && value[10] === 'T' && isLocalDate(value.slice(0, 10)) && isLocalTime(value.slice(11));

/** The moment a wall-clock day and time is, in a zone. */
export const fromLocalDateTime = (value: LocalDateTime, timeZone: string): Date => zonedToInstant(value.slice(0, 10), value.slice(11), timeZone);

/** What the wall clock in a zone shows at a moment, as a form field holds it. Seconds are dropped. */
export function toLocalDateTime(instant: Instant, timeZone: string): LocalDateTime {
  const parts = localParts(instant, timeZone);
  return `${parts.date}T${parts.time}`;
}

/** A calendar month, 'YYYY-MM'. */
export type LocalMonth = string;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isLocalMonth = (value: unknown): value is LocalMonth => typeof value === 'string' && MONTH_PATTERN.test(value);

/** The month a calendar day is in. */
export const monthOf = (date: LocalDate): LocalMonth => date.slice(0, 7);

/** The month `months` after (or, when negative, before) another: December 2026 + 1 is January 2027. */
export function addMonths(month: LocalMonth, months: number): LocalMonth {
  if (!isLocalMonth(month)) throw new RangeError(`Not a month: ${String(month)}`);
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + months;
  return `${pad(Math.floor(index / 12), 4)}-${pad((((index % 12) + 12) % 12) + 1)}`;
}

/** The first and last day of a month. */
export function monthRange(month: LocalMonth): { from: LocalDate; to: LocalDate } {
  const from = `${month}-01`;
  return { from, to: addDays(`${addMonths(month, 1)}-01`, -1) };
}

/** The weekdays in the order a calendar shows them. */
export const weekOrder = (weekStartsOn: 'monday' | 'sunday'): Weekday[] => (weekStartsOn === 'sunday' ? (['sun', ...WEEKDAYS.slice(0, 6)] as Weekday[]) : [...WEEKDAYS]);

/** "December 2026" */
export const monthInWords = (month: LocalMonth): string => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${Number(month.slice(0, 4))}`;

/**
 * A month laid out as a calendar: whole weeks of seven, starting on the given weekday, with
 * null where a cell belongs to the month before or after.
 */
export function monthGrid(month: LocalMonth, weekStartsOn: 'monday' | 'sunday'): (LocalDate | null)[][] {
  const { from, to } = monthRange(month);
  const cells: (LocalDate | null)[] = Array.from({ length: weekOrder(weekStartsOn).indexOf(weekdayOf(from)) }, () => null);
  for (let date = from; date <= to; date = addDays(date, 1)) cells.push(date);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (LocalDate | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Minutes since midnight for a time of day. */
export const minutesOfDay = (time: LocalTime): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
