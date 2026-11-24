/*
 * The attendance engine, tested against the worked tables in plan.md, section 6. Times are
 * written as the clock on the wall shows them and turned into moments in the schedule's zone.
 */
import { describe, expect, it } from 'vitest';
import { closableUntil, decideCheckIn, evaluateDay, nextOpening, summarize, windowOf, type AttendanceBreak, type DayContext, type DayInput, type DayResult, type HolidayOnDay, type LeaveOnDay } from './attendance';
import { addDays, zonedToInstant, type LocalDate } from './dates';
import { exampleA, exampleB, exampleC } from './exampleRules';
import type { EmploymentPeriod } from './org';
import type { ScheduleRules } from './schedules';

const ZONE = 'Asia/Kolkata';
const A = exampleA(ZONE);
const B = exampleB(ZONE);
const C = exampleC(ZONE);
/** A night shift: 22:00 to 06:00, counted for the day it starts on. */
const NIGHT: ScheduleRules = { ...A, name: 'Night', standard: { start: '22:00', end: '06:00', requiredMinutes: 420, fullDayMinutes: 400, halfDayMinutes: 210 } };
/** A shift that starts at midnight. */
const EARLY: ScheduleRules = { ...A, name: 'Early', standard: { start: '00:00', end: '08:00', requiredMinutes: 420, fullDayMinutes: 400, halfDayMinutes: 210 } };
/** A with no break taken off, for clean arithmetic at the thresholds. */
const A_NO_BREAK: ScheduleRules = { ...A, break: { mode: 'none', minutes: 0, appliesAfter: 0 } };

/** The week used throughout: Monday 7 to Sunday 13 December 2026. */
const MON = '2026-12-07';
const TUE = '2026-12-08';
const FRI = '2026-12-11';
const SAT = '2026-12-12';
const SUN = '2026-12-13';
/** Long after that week: every day in it is over. */
const LATER = '2027-01-15T06:00:00.000Z';

/** A moment: the wall clock in a zone on a day. "+1 06:00" is 06:00 the next day. */
function at(date: LocalDate, time: string, zone = ZONE): string {
  const next = time.startsWith('+1 ');
  const [clock, seconds] = [(next ? time.slice(3) : time).slice(0, 5), (next ? time.slice(3) : time).slice(6)];
  const moment = zonedToInstant(next ? addDays(date, 1) : date, clock, zone).getTime() + (seconds ? Number(seconds) * 1000 : 0);
  return new Date(moment).toISOString();
}

interface Setup {
  rules?: ScheduleRules | ((date: LocalDate) => ScheduleRules | null);
  employment?: EmploymentPeriod[];
  holidays?: Record<LocalDate, HolidayOnDay>;
}

function context({ rules = A, employment = [{ from: '2026-01-01', to: null }], holidays = {} }: Setup = {}): DayContext {
  return { rulesOn: typeof rules === 'function' ? rules : () => rules, holidayOn: (date) => holidays[date] ?? null, employment };
}

/** A day's facts: in, out and breaks as wall-clock times on that date, under some rules. */
function punched(rules: ScheduleRules, date: LocalDate, inTime: string, outTime: string | null, breaks: [string, string | null][] = [], more: Partial<DayInput> & { override?: 'present' | 'half_day'; lateExcused?: boolean } = {}): DayInput {
  const zone = rules.timeZone;
  const list: AttendanceBreak[] = breaks.map(([from, to]) => ({ startAt: at(date, from, zone), endAt: to ? at(date, to, zone) : null }));
  return {
    record: { rules, checkInAt: at(date, inTime, zone), checkOutAt: outTime ? at(date, outTime, zone) : null, breaks: list, override: more.override ?? null, lateExcused: more.lateExcused ?? false },
    leave: more.leave,
    pendingCorrection: more.pendingCorrection,
  };
}

/** One day, read long after it is over. */
const day = (rules: ScheduleRules, date: LocalDate, inTime: string, outTime: string | null, breaks: [string, string | null][] = [], more: Parameters<typeof punched>[5] = {}, setup: Setup = {}) =>
  evaluateDay(date, LATER, context({ rules, ...setup }), punched(rules, date, inTime, outTime, breaks, more));

const flagsOf = (result: DayResult) => [...result.flags].sort();
const sumOf = (result: DayResult) => (result.units ? result.units.worked + result.units.leave + result.units.absent + result.units.unresolved : null);
const FULL: LeaveOnDay = { units: 1, part: 'full' };
const FIRST_HALF: LeaveOnDay = { units: 0.5, part: 'first_half' };
const SECOND_HALF: LeaveOnDay = { units: 0.5, part: 'second_half' };

describe('a day with a punch (plan 6.3)', () => {
  it('reads the worked examples for Employee A as the plan does', () => {
    const table: [string, string, number, number, number, string, string[]][] = [
      ['09:10', '18:00', 530, 60, 470, 'present', ['short_hours']],
      ['09:11', '18:30', 559, 60, 499, 'present', ['late']],
      ['09:00', '16:00', 420, 60, 360, 'half_day', ['early_departure', 'short_hours']],
      ['09:00', '14:20', 320, 20, 300, 'half_day', ['early_departure', 'short_hours']],
      ['09:00', '13:30', 270, 0, 270, 'half_day', ['early_departure', 'short_hours']],
      ['09:00', '11:00', 120, 0, 120, 'absent', ['early_departure', 'short_hours']],
    ];
    for (const [inTime, outTime, gross, breakTime, worked, status, flags] of table) {
      const result = day(A, MON, inTime, outTime);
      expect({ gross: result.grossMinutes, break: result.breakMinutes, worked: result.workedMinutes, status: result.status, flags: flagsOf(result) }, `${inTime} to ${outTime}`).toEqual({ gross, break: breakTime, worked, status, flags });
      expect(sumOf(result)).toBe(1);
    }
    expect(day(A, MON, '09:11', '18:30').lateMinutes).toBe(11);
    expect(day(A, MON, '09:00', '16:00').earlyMinutes).toBe(120);
    expect(day(A, MON, '09:10', '18:00').units).toEqual({ worked: 1, leave: 0, absent: 0, unresolved: 0 });
    expect(day(A, MON, '09:00', '16:00').units).toEqual({ worked: 0.5, leave: 0, absent: 0.5, unresolved: 0 });
    expect(day(A, MON, '09:00', '11:00').units).toEqual({ worked: 0, leave: 0, absent: 1, unresolved: 0 });
  });

  it('is late only past the grace, counted from the start time', () => {
    expect(day(A, MON, '09:10', '18:30').flags).not.toContain('late');
    // The clock shows 09:10 for the whole of that minute: seconds are cut, not rounded.
    expect(day(A, MON, '09:10:59', '18:30').flags).not.toContain('late');
    const late = day(A, MON, '09:11', '18:30');
    expect(late.flags).toContain('late');
    expect(late.lateMinutes).toBe(11);
    expect(day(A, MON, '09:09', '18:30').lateMinutes).toBe(0);
    // Early arrival is not lateness, and the time counts.
    const early = day(A, MON, '08:00', '18:00');
    expect(early.flags).toEqual([]);
    expect(early.workedMinutes).toBe(540);
    // No grace at all: one minute past the start is late.
    expect(day({ ...A, lateGraceMinutes: 0 }, MON, '09:00', '18:30').flags).not.toContain('late');
    expect(day({ ...A, lateGraceMinutes: 0 }, MON, '09:01', '18:30').lateMinutes).toBe(1);
  });

  it('counts a full day and a half day at exactly their thresholds', () => {
    // No break, so worked = gross. Full day 7 h 30 (450), half day 4 h (240).
    expect(day(A_NO_BREAK, MON, '09:00', '16:30').status).toBe('present');
    expect(day(A_NO_BREAK, MON, '09:00', '16:29').status).toBe('half_day');
    expect(day(A_NO_BREAK, MON, '09:00', '13:00').status).toBe('half_day');
    expect(day(A_NO_BREAK, MON, '09:00', '12:59').status).toBe('absent');
    expect(day(A_NO_BREAK, MON, '09:00', '12:59').workedMinutes).toBe(239);
  });

  it('works in whole minutes: 09:00:50 to 17:30:10 is 8 h 30, as the screen shows', () => {
    const result = day(A_NO_BREAK, MON, '09:00:50', '17:30:10');
    expect(result.grossMinutes).toBe(510);
    expect(result.status).toBe('present');
    expect(result.flags).toContain('early_departure');
    expect(result.earlyMinutes).toBe(30);
  });

  it('marks an early departure only when the schedule says to, and past its grace', () => {
    expect(day(A, MON, '09:00', '17:59').flags).toContain('early_departure');
    expect(day(A, MON, '09:00', '18:00').flags).not.toContain('early_departure');
    const lenient = { ...A, earlyLeave: { tracked: true, graceMinutes: 15 } };
    expect(day(lenient, MON, '09:00', '17:45').flags).not.toContain('early_departure');
    expect(day(lenient, MON, '09:00', '17:44').earlyMinutes).toBe(16);
    expect(day({ ...A, earlyLeave: { tracked: false, graceMinutes: 0 } }, MON, '09:00', '15:00').flags).not.toContain('early_departure');
  });

  it('takes a fixed break only from time beyond the line', () => {
    // Applies after 5 h: nothing at 5 h, 1 min at 5 h 01, all 60 from 6 h on.
    expect(day(A, MON, '09:00', '14:00').breakMinutes).toBe(0);
    expect(day(A, MON, '09:00', '14:01').breakMinutes).toBe(1);
    expect(day(A, MON, '09:00', '15:00').breakMinutes).toBe(60);
    expect(day(A, MON, '09:00', '15:00').workedMinutes).toBe(300);
    expect(day(A, MON, '09:00', '18:00').breakMinutes).toBe(60);
    // Pressing Break changes nothing when breaks are a fixed length.
    expect(day(A, MON, '09:00', '18:00', [['12:00', '14:00']]).breakMinutes).toBe(60);
  });

  it('never makes a day worse by staying longer', () => {
    let previous = { worked: 0, units: 0 };
    for (let minutes = 0; minutes <= 14 * 60; minutes += 7) {
      const out = `${String(9 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const result = day(A, MON, '09:00', out);
      expect(result.workedMinutes, out).toBeGreaterThanOrEqual(previous.worked);
      expect(result.units!.worked, out).toBeGreaterThanOrEqual(previous.units);
      previous = { worked: result.workedMinutes, units: result.units!.worked };
    }
  });

  it('takes recorded breaks as they were taken, and never less than the allowance', () => {
    const tracked: ScheduleRules = { ...A, break: { mode: 'tracked', minutes: 60, appliesAfter: 300 } };
    expect(day(tracked, MON, '09:00', '18:00').breakMinutes).toBe(60);
    expect(day(tracked, MON, '09:00', '18:00', [['13:00', '13:20']]).breakMinutes).toBe(60);
    expect(day(tracked, MON, '09:00', '18:00', [['13:00', '14:30']]).breakMinutes).toBe(90);
    expect(day(tracked, MON, '09:00', '18:00', [['11:00', '11:30'], ['14:00', '15:00']]).breakMinutes).toBe(90);
    // A short day, under the line: only what was recorded.
    expect(day(tracked, MON, '09:00', '12:00', [['10:00', '10:15']]).breakMinutes).toBe(15);
  });

  it('ends a break that is still running at check-out, and ignores break time outside the day', () => {
    const left = day(C, MON, '11:20', '20:05', [['13:00', '13:30'], ['19:50', null]]);
    expect(left.breakMinutes).toBe(45);
    expect(left.workedMinutes).toBe(480);
    expect(left.onBreakSince).toBeNull();
    // Nonsense breaks (before check-in, after check-out) cannot take time off.
    expect(day(C, MON, '11:00', '19:00', [['09:00', '10:00'], ['19:30', '20:00']]).breakMinutes).toBe(0);
    expect(day(C, MON, '11:00', '19:00', [['10:30', '11:30']]).breakMinutes).toBe(30);
  });

  it('judges a flexible day by its length alone: Employee C is never late and never leaves early', () => {
    const result = day(C, MON, '11:20', '20:05', [['13:00', '13:45']]);
    expect({ gross: result.grossMinutes, break: result.breakMinutes, worked: result.workedMinutes, status: result.status, flags: result.flags }).toEqual({ gross: 525, break: 45, worked: 480, status: 'present', flags: [] });
    expect(result.shiftStartAt).toBeNull();
    expect(day(C, MON, '14:00', '18:30').status).toBe('half_day');
    // Friday is a short day of its own: 4 h is a full day, 2 h half.
    expect(day(C, FRI, '10:00', '14:00').status).toBe('present');
    expect(day(C, FRI, '10:00', '12:00').status).toBe('half_day');
    expect(day(C, FRI, '10:00', '11:59').status).toBe('absent');
    expect(day(C, FRI, '10:00', '14:00').requiredMinutes).toBe(240);
  });

  it('judges A, B and C by their own rules at the same moment', () => {
    // All three check in at 10:03 on Monday and leave at 19:10.
    const a = day(A, MON, '10:03', '19:10');
    const b = day(B, MON, '10:03', '19:10');
    const c = day(C, MON, '10:03', '19:10');
    expect([a.flags.includes('late'), a.lateMinutes]).toEqual([true, 63]);
    expect([b.flags.includes('late'), b.lateMinutes]).toEqual([false, 0]);
    expect(c.flags.includes('late')).toBe(false);
    // Two minutes later B is late too, by their own start time.
    expect(day(B, MON, '10:06', '19:10').lateMinutes).toBe(6);
    expect([a.status, b.status, c.status]).toEqual(['present', 'present', 'present']);
    // C's breaks are recorded, not fixed: none was taken, so none is taken off.
    expect([a.breakMinutes, b.breakMinutes, c.breakMinutes]).toEqual([60, 60, 0]);
  });
});

describe('which day a punch belongs to (plan 6.4)', () => {
  const decide = (rules: ScheduleRules, date: LocalDate, time: string, setup: Setup = {}) => decideCheckIn(at(date, time, rules.timeZone), rules.timeZone, context({ rules, ...setup }));
  const until = (rules: ScheduleRules, date: LocalDate, inTime: string) => closableUntil(date, at(date, inTime), rules, context({ rules })).toISOString();

  it('opens a day shift three hours before its start and keeps it open for a late night', () => {
    expect(windowOf(MON, context())).toEqual({ opensAt: new Date(at(MON, '06:00')), closesAt: new Date(at(MON, '+1 01:00')) });
    expect(decide(A, MON, '06:00')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(decide(A, MON, '08:30')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(decide(A, MON, '23:30')).toEqual({ allowed: true, date: MON, offDay: false });
    // In at 09:00, out at 00:30: the day can be closed until 01:00.
    expect(until(A, MON, '09:00')).toBe(at(MON, '+1 01:00'));
  });

  it('does not let a forgotten check-out be closed the next morning', () => {
    // In at 17:30 and forgotten: sixteen hours would reach 09:30, but Tuesday opens at 06:00.
    expect(until(A, MON, '17:30')).toBe(at(TUE, '06:00'));
    expect(decide(A, TUE, '09:00')).toEqual({ allowed: true, date: TUE, offDay: false });
    const monday = evaluateDay(MON, at(TUE, '09:00'), context(), punched(A, MON, '17:30', null));
    expect(monday.status).toBe('unresolved');
    expect(monday.flags).toContain('missing_check_out');
    expect(monday.closableUntil).toBeNull();
  });

  it('refuses a check-in before the day opens, saying when it does', () => {
    expect(decide(A, TUE, '05:30')).toEqual({ allowed: false, reason: 'Check-in for today opens at 06:00.' });
    expect(decide(A, TUE, '05:59')).toMatchObject({ allowed: false });
    // 01:00 to 06:00 belongs to no shift: Monday has closed and Tuesday has not opened.
    expect(decide(A, TUE, '01:00')).toMatchObject({ allowed: false });
    expect(decide(A, TUE, '00:59')).toEqual({ allowed: true, date: MON, offDay: false });
  });

  it('says so when today has closed', () => {
    // A day that can be closed for only ten hours: its window shuts at 19:00.
    const short = { ...A, missingCheckOut: { closeAfterMinutes: 600, countsAs: 'unresolved' as const } };
    expect(decide(short, MON, '18:59')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(decide(short, MON, '20:00')).toEqual({ allowed: false, reason: 'Check-in for today has closed. It opens again at 06:00 on Tuesday.' });
    expect(decide(short, SAT, '20:00')).toEqual({ allowed: false, reason: 'Check-in for today has closed. It opens again at 06:00 on Monday.' });
  });

  it('counts a night shift for the day it starts on', () => {
    expect(decide(NIGHT, MON, '21:50')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(evaluateDay(MON, LATER, context({ rules: NIGHT }), punched(NIGHT, MON, '21:50', '+1 06:00')).flags).not.toContain('late');
    // 00:30 on Tuesday with nothing before it is Monday's shift, two and a half hours late.
    expect(decide(NIGHT, TUE, '00:30')).toEqual({ allowed: true, date: MON, offDay: false });
    const late = evaluateDay(MON, LATER, context({ rules: NIGHT }), punched(NIGHT, MON, '+1 00:30', '+1 06:00'));
    expect([late.flags.includes('late'), late.lateMinutes]).toEqual([true, 150]);
    // In at 22:00, out at 00:20, back at 00:30: still Monday's shift, which already has its check-in.
    expect(decide(NIGHT, TUE, '00:30').allowed && decide(NIGHT, TUE, '00:30')).toMatchObject({ date: MON });
    // Monday's shift can be joined for sixteen hours from 22:00, to 14:00 on Tuesday. Then nothing is
    // open until Tuesday's own shift opens at 19:00.
    expect(decide(NIGHT, TUE, '13:59')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(decide(NIGHT, TUE, '14:00')).toEqual({ allowed: false, reason: 'Check-in for today opens at 19:00.' });
    expect(decide(NIGHT, TUE, '18:59')).toEqual({ allowed: false, reason: 'Check-in for today opens at 19:00.' });
    expect(decide(NIGHT, TUE, '19:00')).toEqual({ allowed: true, date: TUE, offDay: false });
    const worked = evaluateDay(MON, LATER, context({ rules: NIGHT }), punched(NIGHT, MON, '22:00', '+1 06:00'));
    expect({ gross: worked.grossMinutes, worked: worked.workedMinutes, status: worked.status, flags: worked.flags }).toEqual({ gross: 480, worked: 420, status: 'present', flags: [] });
    expect(worked.shiftEndAt).toBe(at(TUE, '06:00'));
  });

  it('counts a shift that starts at midnight for the day it starts on', () => {
    expect(decide(EARLY, MON, '23:55')).toEqual({ allowed: true, date: TUE, offDay: false });
    expect(decide(EARLY, MON, '21:00')).toEqual({ allowed: true, date: TUE, offDay: false });
    // Monday's own shift began at 00:00 and can be joined until 16:00. After that nothing is open
    // until Tuesday's shift opens, which is at 21:00 this same evening.
    expect(decide(EARLY, MON, '15:59')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(decide(EARLY, MON, '20:59')).toEqual({ allowed: false, reason: 'Check-in for today has closed. It opens again at 21:00.' });
  });

  it('skips days off when looking for the next opening', () => {
    // A works Monday to Saturday. Saturday can be closed until 01:00 on Sunday, not until Monday.
    expect(until(A, SAT, '09:00')).toBe(at(SUN, '01:00'));
    expect(nextOpening(SAT, context())).toEqual({ date: '2026-12-14', opensAt: new Date(at('2026-12-14', '06:00')) });
    // A late Saturday check-in at 22:00 would run sixteen hours, to 14:00 on Sunday: nothing opens before then.
    expect(until(A, SAT, '22:00')).toBe(at(SUN, '14:00'));
  });

  it('takes a check-in on a day off as off-day work, when the schedule allows it', () => {
    expect(decide(A, SUN, '10:00')).toEqual({ allowed: true, date: SUN, offDay: true });
    expect(decide({ ...A, offDayWork: 'blocked' }, SUN, '10:00')).toEqual({ allowed: false, reason: 'Today is your weekly off, and your schedule does not allow checking in on a day off.' });
    const holidays = { [TUE]: { name: 'Founders’ Day', type: 'company' as const } };
    expect(decide(A, TUE, '10:00', { holidays })).toEqual({ allowed: true, date: TUE, offDay: true });
    expect(decide({ ...A, offDayWork: 'blocked' }, TUE, '10:00', { holidays })).toEqual({ allowed: false, reason: 'Today is a holiday (Founders’ Day), and your schedule does not allow checking in on a day off.' });
    // B's weekly off is Friday, A's is Sunday.
    expect(decide(B, FRI, '10:00')).toMatchObject({ offDay: true });
    expect(decide(B, SUN, '10:00')).toEqual({ allowed: true, date: SUN, offDay: false });
  });

  it('opens a flexible day at midnight and ends it at the next', () => {
    expect(decide(C, MON, '00:00')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(decide(C, MON, '23:59')).toEqual({ allowed: true, date: MON, offDay: false });
    expect(windowOf(MON, context({ rules: C }))).toEqual({ opensAt: new Date(at(MON, '00:00')), closesAt: new Date(at(TUE, '00:00')) });
    // In at 11:00 and forgotten: sixteen hours would reach 03:00, but the day ends at midnight.
    expect(closableUntil(MON, at(MON, '11:00'), C, context({ rules: C })).toISOString()).toBe(at(TUE, '00:00'));
    expect(closableUntil(MON, at(MON, '06:00'), C, context({ rules: C })).toISOString()).toBe(at(MON, '22:00'));
  });

  it('refuses someone with no schedule, or outside their employment', () => {
    expect(decideCheckIn(at(MON, '09:00'), ZONE, context({ rules: () => null }))).toEqual({ allowed: false, reason: 'You have no work schedule yet, so you cannot check in. Ask HR to give you one.' });
    expect(decide(A, MON, '09:00', { employment: [{ from: '2026-12-08', to: null }] })).toEqual({ allowed: false, reason: 'Attendance is not being counted for you today. Ask HR if that is wrong.' });
    expect(decide(A, MON, '09:00', { employment: [{ from: '2026-01-01', to: '2026-12-04' }] })).toMatchObject({ allowed: false });
    // The schedule starts tomorrow: today there are no rules yet.
    expect(decide(A, MON, '09:00', { rules: (date) => (date >= TUE ? A : null) })).toMatchObject({ allowed: false, reason: expect.stringContaining('no work schedule yet') });
  });
});

describe('any calendar day (plan 6.5)', () => {
  const read = (date: LocalDate, now: string, setup: Setup = {}, input: DayInput = { record: null }) => evaluateDay(date, now, context(setup), input);

  it('does not apply outside their employment, or before their first schedule', () => {
    const before = read(MON, LATER, { employment: [{ from: TUE, to: null }] });
    expect(before).toMatchObject({ kind: null, status: 'not_applicable', units: null, flags: [] });
    expect(read(MON, LATER, { employment: [{ from: '2026-01-01', to: '2026-12-04' }] }).status).toBe('not_applicable');
    expect(read(MON, LATER, { employment: [] }).status).toBe('not_applicable');
    expect(read(MON, LATER, { rules: (date) => (date >= TUE ? A : null) }).status).toBe('not_applicable');
    // The last day of an employment period still counts; the day after does not.
    expect(read('2026-12-04', LATER, { employment: [{ from: '2026-01-01', to: '2026-12-04' }] }).status).toBe('absent');
    expect(read('2026-12-05', LATER, { employment: [{ from: '2026-01-01', to: '2026-12-04' }] }).status).toBe('not_applicable');
  });

  it('reads a day off as a day off, each person by their own week', () => {
    expect(read(SUN, LATER)).toMatchObject({ kind: 'weekly_off', status: 'weekly_off', units: null });
    expect(read(SUN, LATER, { rules: B }).status).toBe('absent');
    expect(read(FRI, LATER, { rules: B }).status).toBe('weekly_off');
    expect(read(FRI, LATER).status).toBe('absent');
    expect(read(SAT, LATER, { rules: C }).status).toBe('weekly_off');
  });

  it('never marks a holiday absent', () => {
    const holidays = { [TUE]: { name: 'Founders’ Day', type: 'company' as const } };
    const result = read(TUE, LATER, { holidays });
    expect(result).toMatchObject({ kind: 'holiday', status: 'holiday', units: null, holiday: { name: 'Founders’ Day' } });
    // Worked anyway: still a holiday, with the hours shown.
    const worked = read(TUE, LATER, { holidays }, punched(A, TUE, '10:00', '14:00'));
    expect(worked).toMatchObject({ status: 'holiday', units: null, workedMinutes: 240, flags: ['worked_on_off_day'] });
    expect(read(SUN, LATER, {}, punched(A, SUN, '10:00', '13:00'))).toMatchObject({ status: 'weekly_off', workedMinutes: 180, flags: ['worked_on_off_day'] });
  });

  it('makes a weekly off a working day when it is a special working day, on the normal hours', () => {
    const holidays = { [SUN]: { name: 'Year-end push', type: 'special_working_day' as const } };
    expect(read(SUN, LATER, { holidays })).toMatchObject({ kind: 'working', status: 'absent', requiredMinutes: 480 });
    const worked = read(SUN, LATER, { holidays }, punched(A, SUN, '09:20', '18:30'));
    expect(worked).toMatchObject({ status: 'present', lateMinutes: 20 });
    expect(worked.flags).not.toContain('worked_on_off_day');
    // It also beats an ordinary holiday pattern: the engine is told one thing per date.
    expect(windowOf(SUN, context({ holidays }))?.opensAt.toISOString()).toBe(at(SUN, '06:00'));
  });

  it('shows an optional holiday but keeps it a working day', () => {
    const holidays = { [TUE]: { name: 'Onam', type: 'optional' as const } };
    expect(read(TUE, LATER, { holidays })).toMatchObject({ kind: 'working', status: 'absent', holiday: { name: 'Onam', type: 'optional' } });
  });

  it('reads approved leave as leave, never as absent', () => {
    expect(read(MON, LATER, {}, { record: null, leave: FULL })).toMatchObject({ status: 'leave', units: { worked: 0, leave: 1, absent: 0, unresolved: 0 } });
    // They came in anyway: it still counts as leave, and HR is shown that they worked.
    const worked = read(MON, LATER, {}, punched(A, MON, '09:00', '18:00', [], { leave: FULL }));
    expect(worked).toMatchObject({ status: 'leave', units: { worked: 0, leave: 1, absent: 0, unresolved: 0 }, flags: ['worked_on_leave'] });
    // Leave on a day off is not leave at all.
    expect(read(SUN, LATER, {}, { record: null, leave: FULL })).toMatchObject({ status: 'weekly_off', units: null });
    // Not counted until the day is over.
    expect(read(MON, at(MON, '10:00'), {}, { record: null, leave: FULL })).toMatchObject({ status: 'leave', units: null });
  });

  it('accounts for both halves of a day with half-day leave', () => {
    const workedHalf = read(MON, LATER, {}, punched(A, MON, '09:00', '13:30', [], { leave: SECOND_HALF }));
    expect(workedHalf).toMatchObject({ status: 'half_day', units: { worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 } });
    // Leaving at 13:30 is not an early departure when the afternoon is leave.
    expect(flagsOf(workedHalf)).toEqual(['half_day_leave']);
    // A whole day worked on a half-day leave is still half worked, half leave.
    expect(read(MON, LATER, {}, punched(A, MON, '09:00', '18:30', [], { leave: SECOND_HALF })).units).toEqual({ worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 });
    // Too little worked: the other half is absent.
    expect(read(MON, LATER, {}, punched(A, MON, '09:00', '11:00', [], { leave: SECOND_HALF }))).toMatchObject({ status: 'absent', units: { worked: 0, leave: 0.5, absent: 0.5, unresolved: 0 } });
    // Nothing worked at all.
    expect(read(MON, LATER, {}, { record: null, leave: FIRST_HALF })).toMatchObject({ status: 'absent', units: { worked: 0, leave: 0.5, absent: 0.5, unresolved: 0 }, flags: ['half_day_leave'] });
    // Arriving at 14:00 is not late when the morning is leave.
    const afternoon = read(MON, LATER, {}, punched(A, MON, '14:00', '18:00', [], { leave: FIRST_HALF }));
    expect(afternoon.flags).not.toContain('late');
    expect(afternoon.units).toEqual({ worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 });
  });

  it('reads an open day as working, or on a break, while it can still be closed', () => {
    const working = read(MON, at(MON, '12:00'), {}, punched(A, MON, '09:05', null));
    expect(working).toMatchObject({ status: 'working', units: null, grossMinutes: 175, workedMinutes: 175, closableUntil: at(MON, '+1 01:05') });
    const tracked: ScheduleRules = { ...A, break: { mode: 'tracked', minutes: 0, appliesAfter: 0 } };
    const onBreak = read(MON, at(MON, '13:20'), { rules: tracked }, punched(tracked, MON, '09:00', null, [['11:00', '11:10'], ['13:00', null]]));
    expect(onBreak).toMatchObject({ status: 'on_break', onBreakSince: at(MON, '13:00'), grossMinutes: 260, breakMinutes: 30, workedMinutes: 230 });
    // Late shows at once, before the day is closed.
    expect(read(MON, at(MON, '12:00'), {}, punched(A, MON, '09:30', null))).toMatchObject({ status: 'working', lateMinutes: 30, flags: ['late'] });
    // On a day off it reads as working while they are in, and as the day off again afterwards.
    expect(read(SUN, at(SUN, '11:00'), {}, punched(A, SUN, '10:00', null))).toMatchObject({ kind: 'weekly_off', status: 'working', flags: ['worked_on_off_day'] });
  });

  it('counts a missing check-out the way the schedule says', () => {
    const morning = at(TUE, '09:00');
    const as = (countsAs: 'unresolved' | 'half_day' | 'absent', leave?: LeaveOnDay) => {
      const rules: ScheduleRules = { ...A, missingCheckOut: { closeAfterMinutes: 960, countsAs } };
      return evaluateDay(MON, morning, context({ rules }), punched(rules, MON, '09:00', null, [], { leave }));
    };
    expect(as('unresolved')).toMatchObject({ status: 'unresolved', units: { worked: 0, leave: 0, absent: 0, unresolved: 1 }, workedMinutes: 0 });
    expect(as('half_day')).toMatchObject({ status: 'half_day', units: { worked: 0.5, leave: 0, absent: 0.5, unresolved: 0 } });
    expect(as('absent')).toMatchObject({ status: 'absent', units: { worked: 0, leave: 0, absent: 1, unresolved: 0 } });
    for (const countsAs of ['unresolved', 'half_day', 'absent'] as const) expect(as(countsAs).flags).toContain('missing_check_out');
    // With half-day leave only the other half is in question.
    expect(as('unresolved', SECOND_HALF).units).toEqual({ worked: 0, leave: 0.5, absent: 0, unresolved: 0.5 });
    expect(as('half_day', SECOND_HALF).units).toEqual({ worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 });
    // Checking in and never checking out is not a way to avoid an absence: it is counted, and visibly.
    expect(sumOf(as('unresolved'))).toBe(1);
  });

  it('calls a working day absent only once it is over', () => {
    expect(read(TUE, at(MON, '15:00')).status).toBe('upcoming');
    expect(read(MON, at(MON, '07:00')).status).toBe('not_due');
    expect(read(MON, at(MON, '09:10')).status).toBe('not_due');
    expect(read(MON, at(MON, '09:10:01')).status).toBe('not_in');
    expect(read(MON, at(MON, '17:59')).status).toBe('not_in');
    expect(read(MON, at(MON, '17:59')).units).toBeNull();
    expect(read(MON, at(MON, '18:00'))).toMatchObject({ status: 'absent', units: { worked: 0, leave: 0, absent: 1, unresolved: 0 } });
    // B starts an hour later, so is "not due" an hour longer on the same clock.
    expect(read(MON, at(MON, '09:30'), { rules: B }).status).toBe('not_due');
    expect(read(MON, at(MON, '10:06'), { rules: B }).status).toBe('not_in');
    // A flexible day has no start to be late for: it is "not due" until it ends at midnight.
    expect(read(MON, at(MON, '23:59'), { rules: C }).status).toBe('not_due');
    expect(read(MON, at(TUE, '00:00'), { rules: C }).status).toBe('absent');
    // A night shift that started yesterday is still running this morning.
    expect(read(MON, at(TUE, '05:00'), { rules: NIGHT }).status).toBe('not_in');
    expect(read(MON, at(TUE, '06:00'), { rules: NIGHT }).status).toBe('absent');
  });

  it('lets an approved correction set the status, within what leave leaves owed', () => {
    const corrected = read(MON, LATER, {}, punched(A, MON, '09:00', '11:00', [], { override: 'present' }));
    expect(corrected).toMatchObject({ status: 'present', units: { worked: 1, leave: 0, absent: 0, unresolved: 0 }, workedMinutes: 120 });
    expect(corrected.flags).toContain('corrected');
    expect(read(MON, LATER, {}, punched(A, MON, '09:00', '11:00', [], { override: 'half_day' })).units).toEqual({ worked: 0.5, leave: 0, absent: 0.5, unresolved: 0 });
    expect(read(MON, LATER, {}, punched(A, MON, '09:00', '11:00', [], { override: 'present', leave: SECOND_HALF })).units).toEqual({ worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 });
    // An excused late entry stays late, and says it was excused.
    expect(flagsOf(read(MON, LATER, {}, punched(A, MON, '09:40', '18:45', [], { lateExcused: true })))).toEqual(['late', 'late_excused']);
    expect(read(MON, LATER, {}, punched(A, MON, '09:05', '18:45', [], { lateExcused: true })).flags).toEqual([]);
    expect(read(MON, LATER, {}, { record: null, pendingCorrection: true }).flags).toEqual(['pending_correction']);
  });

  it('does not take a day document without a check-in for a punch', () => {
    const noteOnly: DayInput = { record: { rules: A, checkInAt: null, checkOutAt: null, breaks: [], override: null, lateExcused: false } };
    expect(read(MON, LATER, {}, noteOnly)).toMatchObject({ status: 'absent', checkInAt: null });
    expect(read(MON, at(MON, '08:00'), {}, noteOnly).status).toBe('not_due');
  });

  it('reads a day with a punch by the rules it was punched under', () => {
    // Punched under A. The context now says B for that date; the punch keeps A.
    const result = evaluateDay(MON, LATER, context({ rules: B }), punched(A, MON, '09:11', '18:30'));
    expect(result).toMatchObject({ lateMinutes: 11, shiftStartAt: at(MON, '09:00') });
  });
});

describe('history does not change when a schedule does', () => {
  const week = [MON, TUE, '2026-12-09', '2026-12-10', FRI, SAT, SUN];
  const facts: Record<LocalDate, DayInput> = {
    [MON]: punched(A, MON, '09:11', '18:30'),
    [TUE]: punched(A, TUE, '09:00', '13:30'),
    '2026-12-09': punched(A, '2026-12-09', '09:00', null),
    [FRI]: punched(A, FRI, '08:55', '18:05'),
    [SUN]: punched(A, SUN, '10:00', '12:00'),
  };
  const readWeek = (ctx: DayContext, now: string) => week.map((date) => evaluateDay(date, now, ctx, facts[date] ?? { record: null }));

  it('leaves every earlier day reading exactly the same after a change that starts tomorrow', () => {
    const now = at(SUN, '20:00');
    const before = readWeek(context({ rules: A }), now);
    // From Monday the 14th they are on B: other hours, another weekly off, another grace.
    const changed = context({ rules: (date) => (date >= '2026-12-14' ? B : A) });
    expect(readWeek(changed, now)).toEqual(before);
    // And a month later, with the new rules long in force, the old week still reads the same.
    const later = at('2027-01-20', '12:00');
    expect(readWeek(changed, later)).toEqual(readWeek(context({ rules: A }), later));
    expect(summarize(readWeek(changed, later))).toEqual(summarize(readWeek(context({ rules: A }), later)));
    // The statuses themselves, so the test cannot pass by everything being blank.
    expect(before.map((d) => d.status)).toEqual(['present', 'half_day', 'unresolved', 'absent', 'present', 'absent', 'weekly_off']);
  });

  it('judges the days after the change by the new rules', () => {
    const changed = context({ rules: (date) => (date >= '2026-12-14' ? B : A) });
    // Friday the 18th is B's weekly off; Sunday the 20th is now a working day.
    expect(evaluateDay('2026-12-18', LATER, changed).status).toBe('weekly_off');
    expect(evaluateDay('2026-12-20', LATER, changed).status).toBe('absent');
    expect(evaluateDay('2026-12-11', LATER, changed).status).toBe('absent');
    expect(evaluateDay('2026-12-13', LATER, changed).status).toBe('weekly_off');
    // The first day of the new rules opens by the new rules: B starts at 10:00, so check-in opens at 07:00.
    expect(nextOpening('2026-12-12', changed)).toEqual({ date: '2026-12-14', opensAt: new Date(at('2026-12-14', '07:00')) });
  });
});

describe('time zones', () => {
  const DUBAI: ScheduleRules = { ...A, timeZone: 'Asia/Dubai' };
  const LONDON: ScheduleRules = { ...A, timeZone: 'Europe/London' };

  it('judges each person on the wall clock of their own schedule', () => {
    // 09:05 in Dubai is on time there, whatever time it is on the server or in India.
    const dubai = evaluateDay(MON, LATER, context({ rules: DUBAI }), punched(DUBAI, MON, '09:05', '18:10'));
    expect(dubai).toMatchObject({ status: 'present', flags: [], shiftStartAt: '2026-12-07T05:00:00.000Z' });
    // The same moment (05:05 UTC) is 10:35 in India: an hour and a half late for someone on India time.
    const india = evaluateDay(MON, LATER, context({ rules: A }), { record: { rules: A, checkInAt: '2026-12-07T05:05:00.000Z', checkOutAt: '2026-12-07T13:30:00.000Z', breaks: [], override: null, lateExcused: false } });
    expect(india.lateMinutes).toBe(95);
  });

  it('turns the day at the schedule’s own midnight', () => {
    // 19:00 UTC on the 7th: 23:00 on the 7th in Dubai, 00:30 on the 8th in India.
    const moment = '2026-12-07T19:00:00.000Z';
    expect(evaluateDay(TUE, moment, context({ rules: DUBAI })).status).toBe('upcoming');
    expect(evaluateDay(TUE, moment, context({ rules: A })).status).toBe('not_due');
    expect(decideCheckIn(moment, 'Asia/Dubai', context({ rules: DUBAI }))).toEqual({ allowed: true, date: MON, offDay: false });
    expect(decideCheckIn(moment, ZONE, context({ rules: A }))).toEqual({ allowed: true, date: MON, offDay: false });
    // An hour and a half later India's Monday window has closed; Dubai's is open until 01:00 there.
    const later = '2026-12-07T20:30:00.000Z';
    expect(decideCheckIn(later, ZONE, context({ rules: A }))).toMatchObject({ allowed: false });
    expect(decideCheckIn(later, 'Asia/Dubai', context({ rules: DUBAI }))).toEqual({ allowed: true, date: MON, offDay: false });
  });

  it('keeps to the wall clock on a day the clocks change', () => {
    // London, Sunday 29 March 2026: clocks go forward at 01:00. A 09:00 to 18:00 day is unaffected.
    const sunday = '2026-03-29';
    const works = { ...LONDON, days: { ...LONDON.days, sun: 'standard' as const } };
    const result = evaluateDay(sunday, LATER, context({ rules: works }), punched(works, sunday, '09:00', '18:00'));
    expect(result).toMatchObject({ grossMinutes: 540, status: 'present', shiftStartAt: '2026-03-29T08:00:00.000Z', shiftEndAt: '2026-03-29T17:00:00.000Z' });
    expect(evaluateDay('2026-03-28', LATER, context({ rules: works }), punched(works, '2026-03-28', '09:00', '18:00')).shiftStartAt).toBe('2026-03-28T09:00:00.000Z');
    // A night shift across the change is really an hour shorter, and is measured as it was.
    const night = { ...NIGHT, timeZone: 'Europe/London' };
    const across = evaluateDay('2026-03-28', LATER, context({ rules: night }), punched(night, '2026-03-28', '22:00', '+1 06:00'));
    expect(across).toMatchObject({ grossMinutes: 420, shiftStartAt: '2026-03-28T22:00:00.000Z', shiftEndAt: '2026-03-29T05:00:00.000Z' });
    expect(across.flags).not.toContain('early_departure');
    // And when they go back (25 October), an hour longer.
    const back = evaluateDay('2026-10-24', LATER, context({ rules: night }), punched(night, '2026-10-24', '22:00', '+1 06:00'));
    expect(back.grossMinutes).toBe(540);
  });
});

describe('the month’s summary', () => {
  it('adds up one person’s week', () => {
    const ctx = context({ holidays: { '2026-12-10': { name: 'Founders’ Day', type: 'company' } } });
    const days = [
      evaluateDay(MON, LATER, ctx, punched(A, MON, '09:11', '18:30')),
      evaluateDay(TUE, LATER, ctx, punched(A, TUE, '09:00', '13:30')),
      evaluateDay('2026-12-09', LATER, ctx, { record: null, leave: FULL }),
      evaluateDay('2026-12-10', LATER, ctx, punched(A, '2026-12-10', '10:00', '12:00')),
      evaluateDay(FRI, LATER, ctx, punched(A, FRI, '09:00', null)),
      evaluateDay(SAT, LATER, ctx),
      evaluateDay(SUN, LATER, ctx),
    ];
    expect(summarize(days)).toEqual({
      workingDays: 5,
      presentDays: 1,
      halfDays: 1,
      leaveDays: 1,
      unpaidLeaveDays: 0,
      absentDays: 1.5,
      unresolvedDays: 1,
      lateEntries: 1,
      earlyDepartures: 1,
      correctedDays: 0,
      holidays: 1,
      weeklyOffs: 1,
      offDaysWorked: 1,
      workedMinutes: 499 + 270 + 120,
    });
  });

  /** A small repeatable random source, so a failure can be run again. */
  function random(seed: number) {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('always accounts for every working day exactly once, whatever happened in the month', () => {
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
      const base = pick([A, B, C, A_NO_BREAK]);
      const rules: ScheduleRules = { ...base, missingCheckOut: { closeAfterMinutes: 960, countsAs: pick(['unresolved', 'half_day', 'absent'] as const) } };
      const holidays: Record<LocalDate, HolidayOnDay> = {};
      const employment = [{ from: pick(['2026-11-01', '2026-12-03', '2026-12-10']), to: pick([null, null, '2026-12-28']) }];
      const dates = Array.from({ length: 31 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
      for (const date of dates) if (next() < 0.08) holidays[date] = { name: 'Holiday', type: pick(['public', 'company', 'optional', 'special_working_day'] as const) };
      const ctx = context({ rules, holidays, employment });
      // Sometimes the month is read while it is still running.
      const now = pick([LATER, at('2026-12-16', '11:00'), at('2026-12-31', '23:00')]);

      const days = dates.map((date) => {
        const roll = next();
        const leave = next() < 0.12 ? pick([FULL, FIRST_HALF, SECOND_HALF]) : null;
        if (roll < 0.25) return evaluateDay(date, now, ctx, { record: null, leave });
        const inAt = 7 * 60 + Math.floor(next() * 240);
        const length = Math.floor(next() * 660);
        const out = roll < 0.35 ? null : inAt + length < 1440 ? clock(inAt + length) : `+1 ${clock(inAt + length)}`;
        const breaks: [string, string | null][] = next() < 0.3 && length > 120 ? [[clock(inAt + 60), clock(inAt + 60 + Math.floor(next() * 50))]] : [];
        return evaluateDay(date, now, ctx, punched(rules, date, clock(inAt), out, breaks, { leave, override: next() < 0.05 ? pick(['present', 'half_day'] as const) : undefined }));
      });

      for (const d of days) {
        if (!d.units) continue;
        expect(d.kind, `seed ${seed} ${d.date}`).toBe('working');
        expect(sumOf(d), `seed ${seed} ${d.date}`).toBe(1);
        for (const part of Object.values(d.units)) expect([0, 0.5, 1], `seed ${seed} ${d.date}`).toContain(part);
      }
      const s = summarize(days);
      expect(s.presentDays + s.halfDays / 2 + s.leaveDays + s.absentDays + s.unresolvedDays, `seed ${seed}`).toBe(s.workingDays);
      expect(s.workingDays, `seed ${seed}`).toBeLessThanOrEqual(31);
    }
  });
});
