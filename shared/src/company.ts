import { isTimeZone } from './dates';

export type WeekStart = 'monday' | 'sunday';

/** Settings for the whole company. Each employee's own schedule can override the time zone. */
export interface CompanySettings {
  name: string;
  /** The default IANA time zone, e.g. "Asia/Kolkata". */
  timeZone: string;
  /** The first column of calendars. */
  weekStartsOn: WeekStart;
  /** The month the leave year begins in: 1 is January. */
  leaveYearStartMonth: number;
}

/** What an installation has before first-run setup fills it in. */
export const DEFAULT_COMPANY: CompanySettings = { name: '', timeZone: 'UTC', weekStartsOn: 'monday', leaveYearStartMonth: 1 };

export const COMPANY_NAME_MAX = 120;

/** Field-by-field problems with company settings; empty when they are fine. */
export function validateCompany(input: CompanySettings): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 2) errors.name = 'Please enter the company name.';
  else if (name.length > COMPANY_NAME_MAX) errors.name = `Keep this to ${COMPANY_NAME_MAX} characters or fewer.`;
  if (!isTimeZone(input.timeZone)) errors.timeZone = 'Choose a time zone from the list, for example Asia/Kolkata.';
  if (input.weekStartsOn !== 'monday' && input.weekStartsOn !== 'sunday') errors.weekStartsOn = 'Choose Monday or Sunday.';
  if (!Number.isInteger(input.leaveYearStartMonth) || input.leaveYearStartMonth < 1 || input.leaveYearStartMonth > 12) {
    errors.leaveYearStartMonth = 'Choose the month the leave year starts in.';
  }
  return errors;
}
