import { MONTH_NAMES } from '@delta-hrms/shared';

/*
 * How things are written on screen. Dates and times are always written in a named time zone
 * (the company's, or an employee's), never in whatever zone the device happens to be in.
 */

export function initials(name: string) {
  return (
    name
      // Letters (with their marks, for Malayalam and the like) and digits only, so "Mum (home)" is "MH", not "M(".
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}

const TONES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];

/** Stable accent colour for a name, so the same person always gets the same avatar tint. */
export function toneFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
}

/** "Monday, 23 November 2026" */
export const longDate = (moment: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(moment);

/** "13:05" */
export const clockTime = (moment: Date, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(moment);

/** "Monday" */
export const weekdayName = (moment: Date, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(moment);

/** "23 Nov 2026", for a stored moment. */
export const shortDate = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

/** "23 Nov 2026, 13:05", for a stored moment. */
export const dateTime = (iso: string, timeZone: string) => `${shortDate(iso, timeZone)}, ${clockTime(new Date(iso), timeZone)}`;

/** "7 Dec 2026", for a calendar day ('YYYY-MM-DD'). A day has no time zone, so none is applied. */
export const dayDate = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day)));
};

/** "Sat 12 Dec", for a calendar day in a list of days close to today. */
export const shortDay = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(year, month - 1, day))).replace(',', '');
};

/** "5:07:09": hours, minutes and seconds for a running timer. */
export const stopwatch = (minutes: number, seconds: number) => `${Math.floor(minutes / 60)}:${String(Math.floor(minutes % 60)).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

/** A number of days as people write it: 3, 1.5. */
export const dayCount = (days: number) => String(Math.round(days * 10) / 10);

/** A greeting for an hour of the day (0 to 23) in the reader's working time zone. */
export function greeting(hour: number) {
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export const monthName = (month: number) => MONTH_NAMES[month - 1] ?? '';

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
