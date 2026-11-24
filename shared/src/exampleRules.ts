import { startingRules, type ScheduleRules } from './schedules';

/*
 * The three employees the brief describes, as rules. They are the worked examples in plan.md
 * (section 6), the standard schedules of the development sample company, and the fixtures of
 * the tests, so all three always mean the same thing.
 */

/** Employee A: 09:00 to 18:00, a 60-minute break, Sunday off, 10 minutes of grace. */
export function exampleA(timeZone: string): ScheduleRules {
  return {
    ...startingRules(timeZone),
    name: 'General 9 to 6',
    standard: { start: '09:00', end: '18:00', requiredMinutes: 480, fullDayMinutes: 450, halfDayMinutes: 240 },
    days: { mon: 'standard', tue: 'standard', wed: 'standard', thu: 'standard', fri: 'standard', sat: 'standard', sun: 'off' },
    break: { mode: 'fixed', minutes: 60, appliesAfter: 300 },
    lateGraceMinutes: 10,
  };
}

/** Employee B: 10:00 to 19:00, a 60-minute break, Friday off, 5 minutes of grace. */
export function exampleB(timeZone: string): ScheduleRules {
  return {
    ...startingRules(timeZone),
    name: 'Late shift 10 to 7',
    standard: { start: '10:00', end: '19:00', requiredMinutes: 480, fullDayMinutes: 450, halfDayMinutes: 240 },
    days: { mon: 'standard', tue: 'standard', wed: 'standard', thu: 'standard', fri: 'off', sat: 'standard', sun: 'standard' },
    break: { mode: 'fixed', minutes: 60, appliesAfter: 300 },
    lateGraceMinutes: 5,
  };
}

/** Employee C: flexible hours, 8 required, a week of their own (Monday to Thursday 8 h, Friday 4 h). */
export function exampleC(timeZone: string): ScheduleRules {
  return {
    ...startingRules(timeZone),
    name: 'Flexible 8 hours',
    kind: 'flexible',
    standard: { start: null, end: null, requiredMinutes: 480, fullDayMinutes: 480, halfDayMinutes: 240 },
    days: {
      mon: 'standard',
      tue: 'standard',
      wed: 'standard',
      thu: 'standard',
      fri: { start: null, end: null, requiredMinutes: 240, fullDayMinutes: 240, halfDayMinutes: 120 },
      sat: 'off',
      sun: 'off',
    },
    break: { mode: 'tracked', minutes: 0, appliesAfter: 0 },
    lateGraceMinutes: 0,
    earlyCheckInMinutes: 0,
    earlyLeave: { tracked: false, graceMinutes: 0 },
  };
}
