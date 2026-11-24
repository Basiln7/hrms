/*
 * What the home page shows, state by state (plan.md, 6.5), and the live timer. Times are
 * written as the clock on the wall shows them and turned into moments in the schedule's zone.
 */
import { describe, expect, it } from 'vitest';
import type { DayContext, HolidayOnDay, LeaveOnDay } from './attendance';
import { addDays, zonedToInstant, type LocalDate } from './dates';
import { exampleA, exampleC } from './exampleRules';
import type { EmploymentPeriod } from './org';
import type { ScheduleRules } from './schedules';
import { checkOutInWords, composeToday, describeToday, flagWords, liveDay, liveWords, type DayExtras, type DayRecord } from './today';

const ZONE = 'Asia/Kolkata';
const A = exampleA(ZONE);
const C = exampleC(ZONE);
const A_NO_OFF_DAY_WORK: ScheduleRules = { ...A, offDayWork: 'blocked' };
/** A night shift: 22:00 to 06:00, counted for the day it starts on. */
const NIGHT: ScheduleRules = { ...A, name: 'Night', standard: { start: '22:00', end: '06:00', requiredMinutes: 420, fullDayMinutes: 400, halfDayMinutes: 210 } };
/** A shift that starts at midnight, so its check-in opens the evening before. */
const EARLY: ScheduleRules = { ...A, name: 'Early', standard: { start: '00:00', end: '08:00', requiredMinutes: 420, fullDayMinutes: 400, halfDayMinutes: 210 } };

/** Monday 7 to Sunday 13 December 2026. */
const MON = '2026-12-07';
const TUE = '2026-12-08';
const SUN = '2026-12-13';

/** A moment: "09:00" or "09:00:50" on the wall clock of a zone, on a day. */
function at(date: LocalDate, time: string, zone = ZONE): string {
  const seconds = time.length > 5 ? Number(time.slice(6)) : 0;
  return new Date(zonedToInstant(date, time.slice(0, 5), zone).getTime() + seconds * 1000).toISOString();
}

interface Setup {
  rules?: ScheduleRules | null;
  employment?: EmploymentPeriod[];
  holidays?: Record<LocalDate, HolidayOnDay>;
  open?: DayRecord | null;
  nearby?: DayRecord[];
  extras?: Record<LocalDate, DayExtras>;
}

/** Today's state at a wall-clock time on a day, for someone on some rules. */
function todayAt(date: LocalDate, time: string, { rules = A, employment = [{ from: '2026-01-01', to: null }], holidays = {}, open = null, nearby = [], extras = {} }: Setup = {}) {
  const ctx: DayContext = { rulesOn: () => rules, holidayOn: (day) => holidays[day] ?? null, employment };
  return composeToday(at(date, time, rules?.timeZone ?? ZONE), { timeZone: rules?.timeZone ?? ZONE, rules, ctx }, open, nearby, (day) => extras[day] ?? {});
}

/** What was recorded for a day: in, out and breaks as wall-clock times, "+1 06:00" being the next day. */
function record(rules: ScheduleRules, date: LocalDate, inTime: string, outTime: string | null = null, breaks: [string, string | null][] = []): DayRecord {
  const moment = (time: string) => (time.startsWith('+1 ') ? at(addDays(date, 1), time.slice(3)) : at(date, time));
  return { date, rules, checkInAt: moment(inTime), checkOutAt: outTime ? moment(outTime) : null, breaks: breaks.map(([from, to]) => ({ startAt: moment(from), endAt: to ? moment(to) : null })), override: null, lateExcused: false };
}

const FULL: LeaveOnDay = { units: 1, part: 'full' };
const FIRST_HALF: LeaveOnDay = { units: 0.5, part: 'first_half' };
const NO_BUTTONS = { checkIn: false, checkOut: false, startBreak: false, endBreak: false };

describe('today, state by state (plan 6.5)', () => {
  it('no schedule yet: nothing to check in to', () => {
    const today = todayAt(MON, '10:00', { rules: null });
    expect(today.can).toEqual(NO_BUTTONS);
    expect(today.checkInBlocked).toMatch(/no work schedule yet/);
    expect(describeToday(today)).toMatchObject({ state: 'no_schedule', headline: 'No work schedule yet', tone: 'neutral' });
    expect(liveDay(today, at(MON, '10:00'))).toBeNull();
  });

  it('a schedule, but not employed today: not counted', () => {
    const today = todayAt(MON, '10:00', { employment: [{ from: '2026-01-01', to: '2026-11-30' }] });
    expect(today.can).toEqual(NO_BUTTONS);
    expect(describeToday(today)).toEqual({ state: 'not_counted', headline: 'Not counted today', lines: ['Attendance is not being counted for you today. Ask HR if that is wrong.'], tone: 'neutral' });
  });

  it('a weekly off: offered when the schedule records work on a day off, refused when it does not', () => {
    const allowed = todayAt(SUN, '10:00');
    expect(allowed.can.checkIn).toBe(true);
    expect(describeToday(allowed)).toEqual({
      state: 'day_off',
      headline: 'Weekly off',
      lines: ['Today is your weekly off.', 'If you are working anyway, you can check in: the hours are recorded as work on a day off.'],
      tone: 'neutral',
    });

    const blocked = todayAt(SUN, '10:00', { rules: A_NO_OFF_DAY_WORK });
    expect(blocked.can).toEqual(NO_BUTTONS);
    expect(describeToday(blocked)).toMatchObject({ state: 'day_off', lines: ['Today is your weekly off, and your schedule does not allow checking in on a day off.'] });
  });

  it('a holiday, by its name', () => {
    const today = todayAt(MON, '10:00', { holidays: { [MON]: { name: 'Founders Day', type: 'company' } } });
    expect(describeToday(today)).toMatchObject({ state: 'day_off', headline: 'Holiday' });
    expect(describeToday(today).lines[0]).toBe('Today is a holiday (Founders Day).');
  });

  it('on approved leave', () => {
    const today = todayAt(MON, '10:00', { extras: { [MON]: { leave: FULL } } });
    expect(today.day.status).toBe('leave');
    expect(describeToday(today)).toEqual({ state: 'on_leave', headline: 'On leave', lines: ['You have approved leave today.', 'If you are working anyway, you can still check in.'], tone: 'neutral' });
  });

  it('not due yet: before check-in opens, before the start, and inside the grace', () => {
    const tooEarly = todayAt(MON, '05:30');
    expect(tooEarly.can.checkIn).toBe(false);
    expect(describeToday(tooEarly)).toEqual({ state: 'not_due', headline: 'Not checked in', lines: ['Your day starts at 09:00.', 'Check-in for today opens at 06:00.'], tone: 'neutral' });

    const before = todayAt(MON, '08:30');
    expect(before.can.checkIn).toBe(true);
    expect(describeToday(before).lines).toEqual(['Your day starts at 09:00. Arriving up to 09:10 is on time.']);

    const inGrace = todayAt(MON, '09:05');
    expect(inGrace.day.status).toBe('not_due');
    expect(describeToday(inGrace).lines).toEqual(['Your day started at 09:00. Checking in by 09:10 is still on time.']);
  });

  it('not due yet on flexible hours, which have no start time to be late for', () => {
    const today = todayAt(MON, '15:00', { rules: C });
    expect(today.day.status).toBe('not_due');
    expect(describeToday(today)).toEqual({ state: 'not_due', headline: 'Not checked in', lines: ['Flexible hours: today needs 8 h of work. Check in when you start.'], tone: 'neutral' });
  });

  it('not in: past the grace, and says a check-in now is late', () => {
    const today = todayAt(MON, '09:11');
    expect(today.day.status).toBe('not_in');
    expect(describeToday(today)).toEqual({ state: 'not_in', headline: 'Not checked in', lines: ['Your day started at 09:00. Checking in now is a late entry.'], tone: 'warn' });
  });

  it('the day ended with no check-in: absent, and a late start is still possible', () => {
    const today = todayAt(MON, '19:00');
    expect(today.day.status).toBe('absent');
    expect(today.can.checkIn).toBe(true);
    expect(describeToday(today).lines).toEqual(['Your day ended at 18:00 with no check-in, so it counts as absent.', 'If you are only starting now, you can still check in.']);
  });

  it('working, with the late entry said in minutes', () => {
    const onTime = todayAt(MON, '11:00', { open: record(A, MON, '08:55') });
    expect(onTime.can).toEqual({ checkIn: false, checkOut: true, startBreak: false, endBreak: false });
    expect(describeToday(onTime)).toEqual({ state: 'working', headline: 'Working', lines: ['Checked in at 08:55.'], tone: 'good' });
    expect(flagWords(onTime.day)).toEqual([]);

    const late = todayAt(MON, '11:00', { open: record(A, MON, '09:26') });
    expect(flagWords(late.day)).toEqual([{ flag: 'late', text: 'Late by 26 min', tone: 'warn' }]);
  });

  it('on a break, where the schedule records them', () => {
    const working = todayAt(MON, '12:00', { rules: C, open: record(C, MON, '10:00') });
    expect(working.can).toEqual({ checkIn: false, checkOut: true, startBreak: true, endBreak: false });

    const onBreak = todayAt(MON, '13:20', { rules: C, open: record(C, MON, '10:00', null, [['13:00', null]]) });
    expect(onBreak.can).toEqual({ checkIn: false, checkOut: true, startBreak: false, endBreak: true });
    expect(describeToday(onBreak)).toEqual({ state: 'on_break', headline: 'On break', lines: ['Checked in at 10:00.', 'On a break since 13:00.'], tone: 'neutral' });
  });

  it('checked out: a full day, a half-day and an absence each say what they are and why', () => {
    const full = todayAt(MON, '18:30', { nearby: [record(A, MON, '08:55', '18:05')] });
    expect(full.can).toEqual(NO_BUTTONS);
    expect(describeToday(full)).toEqual({ state: 'checked_out', headline: 'Checked out', lines: ['08:55 to 18:05, 8 h 10 min worked after 1 h of break.', 'Today counts as a full day.'], tone: 'good' });

    const half = todayAt(MON, '18:30', { nearby: [record(A, MON, '09:00', '16:00')] });
    expect(describeToday(half)).toMatchObject({ lines: ['09:00 to 16:00, 6 h worked after 1 h of break.', 'Today counts as a half-day: a full day needs 7 h 30 min.'], tone: 'warn' });
    expect(flagWords(half.day).map((f) => f.text)).toEqual(['Left 2 h early', 'Short by 2 h']);

    const absent = todayAt(MON, '18:30', { nearby: [record(A, MON, '09:00', '11:00')] });
    expect(describeToday(absent)).toMatchObject({ lines: ['09:00 to 11:00, 2 h worked.', 'Today counts as absent: half a day needs 4 h.'], tone: 'warn' });
  });

  it('checked out on a day off: the hours are recorded and the day stays a day off', () => {
    const today = todayAt(SUN, '14:00', { nearby: [record(A, SUN, '10:00', '13:00')] });
    expect(today.day.status).toBe('weekly_off');
    expect(today.can).toEqual(NO_BUTTONS);
    expect(describeToday(today)).toEqual({ state: 'checked_out', headline: 'Checked out', lines: ['10:00 to 13:00, 3 h worked.', 'Recorded as work on a day off.'], tone: 'neutral' });
    expect(flagWords(today.day).map((f) => f.text)).toEqual(['Worked on a day off']);
  });

  it('half-day leave and the other half worked: complete', () => {
    const today = todayAt(MON, '18:30', { nearby: [record(A, MON, '13:30', '18:00')], extras: { [MON]: { leave: FIRST_HALF } } });
    expect(today.day).toMatchObject({ status: 'half_day', units: { worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 } });
    expect(describeToday(today)).toMatchObject({ lines: ['13:30 to 18:00, 4 h 30 min worked.', 'With your half-day leave, today is complete.'], tone: 'good' });
    expect(flagWords(today.day).map((f) => f.text)).toEqual(['Half-day leave']);
  });

  it('still checked in from an earlier day: said in words, with until when it can be closed', () => {
    const today = todayAt(TUE, '00:30', { open: record(A, MON, '17:30') });
    expect(today).toMatchObject({ today: TUE, openFromEarlier: true, can: { checkIn: false, checkOut: true } });
    expect(today.day.date).toBe(MON);
    const words = describeToday(today);
    expect(words).toMatchObject({ state: 'working', headline: 'Working' });
    expect(words.lines[0]).toBe('Still checked in since Monday 7 December, 17:30.');
    expect(words.lines[1]).toBe('Checking out records the time as it is now, and is possible until 06:00. If you left earlier and forgot to check out, do not check out now: let the day close by itself and ask for a correction of the check-out.');
  });

  it('a check-out forgotten yesterday does not stand in the way of today', () => {
    const forgotten = record(A, MON, '17:30');
    const today = todayAt(TUE, '08:00', { open: forgotten, nearby: [forgotten] });
    expect(today.day).toMatchObject({ date: TUE, status: 'not_due' });
    expect(today.can.checkIn).toBe(true);
    expect(today.openFromEarlier).toBe(false);
  });

  it('a check-out missed on the same day: said so, with what the day counts as', () => {
    const early = record(A, MON, '06:00');
    const unresolved = todayAt(MON, '22:30', { open: early, nearby: [early] });
    expect(unresolved.can).toEqual(NO_BUTTONS);
    expect(describeToday(unresolved)).toEqual({ state: 'missing_check_out', headline: 'Missing check-out', lines: ['You checked in at 06:00 and did not check out in time.', 'The day stays unresolved until it is corrected.'], tone: 'warn' });
    // "Unresolved" says it already: the flag is not repeated beside it.
    expect(unresolved.day.flags).toContain('missing_check_out');
    expect(flagWords(unresolved.day).map((f) => f.text)).not.toContain('Missing check-out');

    const countsHalf: ScheduleRules = { ...A, missingCheckOut: { ...A.missingCheckOut, countsAs: 'half_day' } };
    const asHalf = record(countsHalf, MON, '06:00');
    const half = todayAt(MON, '22:30', { rules: countsHalf, open: asHalf, nearby: [asHalf] });
    expect(describeToday(half).lines[1]).toBe('It counts as a half-day unless it is corrected.');
    // Where the day reads as something else, the flag is what says why.
    expect(flagWords(half.day).map((f) => f.text)).toContain('Missing check-out');
  });

  it('a night shift is named by the day it started on, never called today', () => {
    const notIn = todayAt(TUE, '00:30', { rules: NIGHT });
    expect(notIn).toMatchObject({ today: TUE, day: { date: MON, status: 'not_in' } });
    expect(describeToday(notIn).lines).toEqual(['Your day started at 22:00 on Monday 7 December. Checking in now is a late entry.']);

    const done = todayAt(TUE, '07:00', { rules: NIGHT, nearby: [record(NIGHT, MON, '22:00', '+1 06:00')] });
    expect(describeToday(done).lines).toEqual(['Monday 7 December: 22:00 to 06:00, 7 h worked after 1 h of break.', 'The day counts as a full day.']);
    expect(done.checkInBlocked).toMatch(/already checked in for Monday 7 December/);
  });

  it('a shift that starts at midnight opens the evening before, for tomorrow', () => {
    const today = todayAt(MON, '21:30', { rules: EARLY });
    expect(today).toMatchObject({ today: MON, day: { date: TUE, status: 'upcoming' }, can: { checkIn: true } });
    expect(describeToday(today)).toMatchObject({ state: 'not_due', lines: ['Your day starts at 00:00 on Tuesday 8 December. Arriving up to 00:10 is on time.'] });
  });

  it('any state carries "correction pending" while one is waiting', () => {
    const today = todayAt(MON, '18:30', { nearby: [record(A, MON, '09:00', '16:00')], extras: { [MON]: { pendingCorrection: true } } });
    expect(flagWords(today.day).map((f) => f.text)).toContain('Correction pending');
  });

  it('gives the day’s own rules, hours and breaks, which the timer counts with', () => {
    const open = todayAt(MON, '13:20', { rules: C, open: record(C, MON, '10:00', null, [['11:00', '11:15'], ['13:00', null]]) });
    expect(open.dayRules?.name).toBe('Flexible 8 hours');
    expect(open.hours).toEqual({ start: null, end: null, requiredMinutes: 480, fullDayMinutes: 480, halfDayMinutes: 240 });
    expect(open.breaks).toHaveLength(2);
    expect(todayAt(SUN, '10:00')).toMatchObject({ hours: null, breaks: [] });
    expect(todayAt(MON, '10:00', { rules: null })).toMatchObject({ dayRules: null, hours: null });
  });
});

describe('the live timer', () => {
  /** A payload from one moment, and the same day counted later by the timer and by the server. */
  const both = (rules: ScheduleRules, open: DayRecord, askedAt: string, laterAt: string) => {
    const asked = todayAt(MON, askedAt, { rules, open });
    const later = todayAt(MON, laterAt, { rules, open });
    return { live: liveDay(asked, at(MON, laterAt))!, server: later.day };
  };

  it('counts exactly as the server does, minute for minute, through a whole day', () => {
    const fixedBreak = record(A, MON, '08:55:40');
    const recordedBreaks = record(C, MON, '10:00', null, [['11:00', '11:15:30'], ['13:00', null]]);
    for (const [rules, open, first] of [
      [A, fixedBreak, 9 * 60],
      [C, recordedBreaks, 13 * 60 + 1],
    ] as const) {
      for (let minute = first; minute < 23 * 60; minute += 7) {
        const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        const { live, server } = both(rules, open, `${String(Math.floor(first / 60)).padStart(2, '0')}:${String(first % 60).padStart(2, '0')}`, clock);
        expect([clock, live.grossMinutes, live.breakMinutes, live.workedMinutes]).toEqual([clock, server.grossMinutes, server.breakMinutes, server.workedMinutes]);
      }
    }
  });

  it('ticks in seconds while the worked time is moving', () => {
    const open = record(A, MON, '09:00');
    expect(both(A, open, '09:30', '13:59:30').live).toMatchObject({ workedMinutes: 299, moving: true, seconds: 30 });
  });

  it('stands still while the fixed break is being taken off, then moves again', () => {
    const open = record(A, MON, '09:00');
    // 60 minutes are taken off the time beyond 5 hours: from 14:00 to 15:00 nothing is added.
    expect(both(A, open, '09:30', '14:00:00').live).toMatchObject({ workedMinutes: 300, breakMinutes: 0, moving: false, seconds: 0 });
    expect(both(A, open, '09:30', '14:30:20').live).toMatchObject({ workedMinutes: 300, breakMinutes: 30, moving: false, seconds: 0 });
    expect(both(A, open, '09:30', '15:00:25').live).toMatchObject({ workedMinutes: 300, breakMinutes: 60, moving: true, seconds: 25 });
    expect(both(A, open, '09:30', '15:01:05').live).toMatchObject({ workedMinutes: 301, moving: true, seconds: 5 });
  });

  it('stands still on a recorded break, and counts the break instead', () => {
    const open = record(C, MON, '10:00', null, [['13:00', null]]);
    expect(both(C, open, '13:05', '13:20:15').live).toMatchObject({ grossMinutes: 200, workedMinutes: 180, breakMinutes: 20, onBreakMinutes: 20, moving: false, seconds: 0 });
  });

  it('stops where the day can no longer be checked out', () => {
    const asked = todayAt(MON, '20:00', { open: record(A, MON, '08:55') });
    expect(asked.day.closableUntil).toBe(at(TUE, '00:55'));
    // Read hours later, with no newer answer from the server: the timer has not run past the limit.
    expect(liveDay(asked, at(TUE, '03:00'))).toMatchObject({ grossMinutes: 960, workedMinutes: 900, moving: false, seconds: 0 });
  });

  it('says what the day would count as if it were checked out now, to the minute', () => {
    const open = record(A, MON, '09:00');
    const countsAs = (time: string) => both(A, open, '09:30', time).live.wouldCountAs;
    expect([countsAs('12:59'), countsAs('13:00')]).toEqual(['absent', 'half_day']);
    // A full day is 7 h 30 worked, which with the hour's break is 17:30.
    expect([countsAs('17:29'), countsAs('17:30')]).toEqual(['half_day', 'present']);
    // On a day off the length decides nothing.
    expect(liveDay(todayAt(SUN, '12:00', { open: record(A, SUN, '10:00') }), at(SUN, '12:00'))).toMatchObject({ workedMinutes: 120, wouldCountAs: null });
  });

  it('is nothing when no day is open', () => {
    expect(liveDay(todayAt(MON, '08:30'), at(MON, '08:30'))).toBeNull();
    expect(liveDay(todayAt(MON, '18:30', { nearby: [record(A, MON, '08:55', '18:05')] }), at(MON, '18:30'))).toBeNull();
  });

  it('says what is still needed, and where on the way half a day lies', () => {
    const open = record(A, MON, '09:00');
    const wordsAt = (time: string) => {
      const today = todayAt(MON, time, { open });
      return liveWords(today, liveDay(today, at(MON, time))!);
    };
    // Half a day is 4 h of the 7 h 30 a full day needs.
    expect(wordsAt('11:00')).toEqual({ progress: { fraction: 120 / 450, halfAt: 240 / 450, text: '2 h more makes half a day, 5 h 30 min a full day.' }, paused: null });
    expect(wordsAt('13:30').progress?.text).toBe('Half a day is reached. 3 h more makes a full day.');
    expect(wordsAt('17:30').progress).toMatchObject({ fraction: 1, text: 'A full day is reached. 30 min more makes the 8 h expected.' });
    expect(wordsAt('18:00').progress?.text).toBe('A full day is reached.');
    // Never past full, however long the day gets.
    expect(wordsAt('21:00').progress?.fraction).toBe(1);
  });

  it('says why the time has stopped: the fixed break, a recorded break, or a day that can no longer be closed', () => {
    const fixed = todayAt(MON, '14:20', { open: record(A, MON, '09:00') });
    expect(liveWords(fixed, liveDay(fixed, at(MON, '14:20'))!).paused).toBe('Paused: your 1 h break is being taken off now. 20 min of it so far.');
    const starting = todayAt(MON, '14:00', { open: record(A, MON, '09:00') });
    expect(liveWords(starting, liveDay(starting, at(MON, '14:00'))!).paused).toBe('Paused: your 1 h break is being taken off now.');

    const recorded = todayAt(MON, '13:20', { rules: C, open: record(C, MON, '10:00', null, [['13:00', null]]) });
    expect(liveWords(recorded, liveDay(recorded, at(MON, '13:20'))!).paused).toBe('Paused: on a break for 20 min.');

    const stale = todayAt(MON, '20:00', { open: record(A, MON, '08:55') });
    expect(liveWords(stale, liveDay(stale, at(TUE, '03:00'))!).paused).toMatch(/can no longer be checked out/);

    const moving = todayAt(MON, '11:00', { open: record(A, MON, '09:00') });
    expect(liveWords(moving, liveDay(moving, at(MON, '11:00'))!).paused).toBeNull();
  });

  it('has no progress to show on a day off, where the length decides nothing', () => {
    const today = todayAt(SUN, '12:00', { open: record(A, SUN, '10:00') });
    expect(liveWords(today, liveDay(today, at(SUN, '12:00'))!)).toEqual({ progress: null, paused: null });
  });

  it('measures a day with half-day leave against the half that is owed', () => {
    const today = todayAt(MON, '16:00', { open: record(A, MON, '13:30'), extras: { [MON]: { leave: FIRST_HALF } } });
    expect(liveWords(today, liveDay(today, at(MON, '16:00'))!).progress).toEqual({ fraction: 150 / 240, halfAt: null, text: '1 h 30 min more completes the half of today that is not leave.' });
  });
});

describe('what checking out now would mean', () => {
  const ask = (date: LocalDate, time: string, setup: Setup) => checkOutInWords(todayAt(date, time, setup), at(date, time));

  it('warns when the day would be an absence, and that leaving early is marked', () => {
    expect(ask(MON, '11:00', { open: record(A, MON, '09:00') })).toEqual({
      lines: ['You have worked 2 h.', 'Checking out now makes today count as absent: half a day needs 4 h.', 'Leaving before 18:00 is also marked as an early departure.', 'You cannot check in again for today afterwards.'],
      warn: true,
    });
  });

  it('warns when the day would be a half-day', () => {
    expect(ask(MON, '16:00', { open: record(A, MON, '09:00') })).toMatchObject({ lines: ['You have worked 6 h.', 'Checking out now makes today a half-day: a full day needs 7 h 30 min.', 'Leaving before 18:00 is also marked as an early departure.', 'You cannot check in again for today afterwards.'], warn: true });
  });

  it('does not warn about a full day', () => {
    expect(ask(MON, '18:05', { open: record(A, MON, '08:55') })).toEqual({ lines: ['You have worked 8 h 10 min.', 'That is a full day.', 'You cannot check in again for today afterwards.'], warn: false });
  });

  it('names the day when it began on an earlier date', () => {
    expect(ask(TUE, '00:30', { open: record(A, MON, '17:30') })).toEqual({
      lines: ['You have worked 6 h, counted for Monday 7 December.', 'Checking out now makes Monday 7 December a half-day: a full day needs 7 h 30 min.', 'You cannot check in again for that day afterwards.'],
      warn: true,
    });
  });

  it('says a day off stays a day off', () => {
    expect(ask(SUN, '13:00', { open: record(A, SUN, '10:00') })).toEqual({ lines: ['You have worked 3 h.', 'The hours are recorded as work on a day off.', 'You cannot check in again for today afterwards.'], warn: false });
  });

  it('is nothing when there is nothing to check out of', () => {
    expect(ask(MON, '08:30', {})).toBeNull();
  });
});

describe('a day’s flags in words', () => {
  it('gives the minutes that go with them', () => {
    const short = todayAt(MON, '18:30', { nearby: [record(A, MON, '09:10', '18:00')] });
    expect(flagWords(short.day)).toEqual([{ flag: 'short_hours', text: 'Short by 10 min', tone: 'neutral' }]);
  });

  it('says a late entry was excused, once', () => {
    const excused = { ...record(A, MON, '09:40', '18:40'), lateExcused: true };
    expect(flagWords(todayAt(MON, '19:00', { nearby: [excused] }).day)).toEqual([{ flag: 'late_excused', text: 'Late by 40 min, excused', tone: 'neutral' }]);
  });
});
