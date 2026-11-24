import { describe, expect, it } from 'vitest';
import { evaluateDay, type DayContext } from './attendance';
import { addMonths, isLocalMonth, monthGrid, monthInWords, monthOf, monthRange, weekOrder } from './dates';
import { exampleA } from './exampleRules';
import { calendarNameProblem, calendarStartBlocker, copyYear, effectInWords, hasEffect, holidayLookup, holidaysFor, validateHoliday, type HolidayInput } from './holidays';

const good: HolidayInput = { date: '2026-12-25', name: 'Christmas Day', type: 'public', description: '' };

describe('a holiday', () => {
  it('is sound with a real date, a name and a kind', () => {
    expect(validateHoliday(good)).toEqual({});
    expect(validateHoliday({ ...good, type: 'special_working_day', description: 'Stock-taking' })).toEqual({});
  });

  it('says what is wrong, field by field', () => {
    expect(validateHoliday({ ...good, date: '2026-02-30' })).toEqual({ date: 'Choose the date of the holiday.' });
    expect(validateHoliday({ ...good, date: '1999-12-25' })).toEqual({ date: 'Choose a date between 2000 and 2100.' });
    expect(validateHoliday({ ...good, date: '2101-01-01' })).toEqual({ date: 'Choose a date between 2000 and 2100.' });
    expect(validateHoliday({ ...good, name: ' ' })).toEqual({ name: 'Give the holiday a name.' });
    expect(Object.keys(validateHoliday({ ...good, name: 'x'.repeat(81) }))).toEqual(['name']);
    expect(Object.keys(validateHoliday({ ...good, type: 'bank' as never }))).toEqual(['type']);
    expect(Object.keys(validateHoliday({ ...good, description: 'x'.repeat(301) }))).toEqual(['description']);
    expect(Object.keys(validateHoliday({ date: '', name: '', type: 'public', description: '' }))).toEqual(['date', 'name']);
  });

  it('belongs to a calendar with a name', () => {
    expect(calendarNameProblem('India')).toBeNull();
    expect(calendarNameProblem(' ')).toBe('Give the calendar a name.');
    expect(calendarNameProblem('x'.repeat(61))).toMatch(/60 characters/);
  });
});

/** Someone on calendar A from March, moved to calendar B from 1 July, and to no calendar from 1 December. */
const history = [
  { effectiveFrom: '2026-03-01', holidayCalendarId: 'cal_a' },
  { effectiveFrom: '2026-07-01', holidayCalendarId: 'cal_b' },
  { effectiveFrom: '2026-12-01', holidayCalendarId: null },
];
const holidays = [
  { calendarId: 'cal_a', date: '2026-01-26', name: 'Republic Day', type: 'public' as const },
  { calendarId: 'cal_a', date: '2026-05-01', name: 'May Day', type: 'public' as const },
  { calendarId: 'cal_a', date: '2026-08-15', name: 'Independence Day', type: 'public' as const },
  { calendarId: 'cal_b', date: '2026-05-01', name: 'Labour Day (UAE)', type: 'company' as const },
  { calendarId: 'cal_b', date: '2026-12-02', name: 'National Day', type: 'public' as const },
  { calendarId: 'cal_b', date: '2026-08-20', name: 'Stock-taking', type: 'special_working_day' as const },
];

describe('which holidays are one person’s', () => {
  const on = holidayLookup(history, holidays);

  it('reads each date from the calendar they were on that day', () => {
    expect(on('2026-05-01')).toEqual({ name: 'May Day', type: 'public' });
    expect(on('2026-08-20')).toEqual({ name: 'Stock-taking', type: 'special_working_day' });
  });

  it('does not reach back: a holiday on a calendar they have since left, or have not yet joined, is not theirs', () => {
    // 15 August is on calendar A, which they left on 1 July.
    expect(on('2026-08-15')).toBeNull();
    // 2 December is on calendar B, which they left the day before.
    expect(on('2026-12-02')).toBeNull();
    // Before their first schedule there is no calendar at all.
    expect(on('2026-01-26')).toBeNull();
  });

  it('lists a range in order, each date from the calendar in force then', () => {
    expect(holidaysFor(history, holidays, '2026-01-01', '2026-12-31').map((h) => h.name)).toEqual(['May Day', 'Stock-taking']);
    expect(holidaysFor(history, holidays, '2026-08-01', '2026-08-31').map((h) => h.name)).toEqual(['Stock-taking']);
    expect(holidaysFor([], holidays, '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('gives two people on two calendars two different days', () => {
    const A = exampleA('Asia/Kolkata');
    const ctx = (calendarId: string): DayContext => ({ rulesOn: () => A, holidayOn: holidayLookup([{ effectiveFrom: '2026-01-01', holidayCalendarId: calendarId }], holidays), employment: [{ from: '2026-01-01', to: null }] });
    const later = '2027-01-01T00:00:00.000Z';
    // Saturday 15 August 2026: a holiday on calendar A, an ordinary working day on calendar B.
    expect(evaluateDay('2026-08-15', later, ctx('cal_a'))).toMatchObject({ kind: 'holiday', status: 'holiday', units: null, holiday: { name: 'Independence Day' } });
    expect(evaluateDay('2026-08-15', later, ctx('cal_b'))).toMatchObject({ kind: 'working', status: 'absent', units: { absent: 1 } });
  });
});

describe('a change of calendar', () => {
  it('starts on a day that has not begun', () => {
    expect(calendarStartBlocker('2026-12-08', '2026-12-07')).toBeNull();
    expect(calendarStartBlocker('2026-12-07', '2026-12-07')).toMatch(/tomorrow at the earliest/);
    expect(calendarStartBlocker('2026-11-30', '2026-12-07')).toMatch(/tomorrow at the earliest/);
    expect(calendarStartBlocker('', '2026-12-07')).toBe('Choose the date the calendar starts.');
  });
});

describe('copying a year', () => {
  const year2028: HolidayInput[] = [
    { date: '2028-12-25', name: 'Christmas Day', type: 'public', description: '' },
    { date: '2028-01-26', name: 'Republic Day', type: 'public', description: 'Flag hoisting at 9' },
    { date: '2028-02-29', name: 'Leap day off', type: 'company', description: '' },
    { date: '2028-05-01', name: 'May Day', type: 'public', description: '' },
  ];

  it('moves each holiday to the same date, in order, and keeps its kind and notes', () => {
    const { copy } = copyYear(year2028, 2029, new Set(), '2028-06-01');
    expect(copy).toEqual([
      { date: '2029-01-26', name: 'Republic Day', type: 'public', description: 'Flag hoisting at 9' },
      { date: '2029-05-01', name: 'May Day', type: 'public', description: '' },
      { date: '2029-12-25', name: 'Christmas Day', type: 'public', description: '' },
    ]);
  });

  it('leaves out, with the reason, a date that does not exist, one already taken, and one that has begun', () => {
    const { copy, skipped } = copyYear(year2028, 2029, new Set(['2029-05-01']), '2029-01-26');
    expect(copy.map((h) => h.date)).toEqual(['2029-12-25']);
    expect(skipped).toEqual([
      { date: '2029-01-26', name: 'Republic Day', reason: 'That date has already begun. Add it by hand, so that what it changes is shown first.' },
      { date: '2029-02-29', name: 'Leap day off', reason: '29 February does not exist in 2029.' },
      { date: '2029-05-01', name: 'May Day', reason: 'That date already has a holiday.' },
    ]);
  });
});

describe('what a change to the past does, in words', () => {
  it('is nothing when no day that has begun changes', () => {
    expect(hasEffect({ people: 0, changes: [] })).toBe(false);
    expect(effectInWords({ people: 0, changes: [] })).toEqual([]);
  });

  it('says how many people, and how their days will read', () => {
    expect(
      effectInWords({
        people: 4,
        changes: [
          { date: '2026-12-07', from: 'absent', to: 'holiday', count: 1 },
          { date: '2026-12-07', from: 'present', to: 'holiday', count: 3 },
        ],
      }),
    ).toEqual(['This changes days that have already begun, for 4 people.', 'Monday 7 December: 1 day that reads Absent will read Holiday.', 'Monday 7 December: 3 days that read Present will read Holiday.']);
    expect(effectInWords({ people: 1, changes: [{ date: '2026-12-07', from: 'holiday', to: 'absent', count: 1 }] })[0]).toBe('This changes days that have already begun, for 1 person.');
  });
});

describe('months', () => {
  it('knows a month from other text', () => {
    expect(isLocalMonth('2026-12')).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-12', '2026-12-01', '', null, 202612]) expect(isLocalMonth(bad)).toBe(false);
    expect(monthOf('2026-12-07')).toBe('2026-12');
    expect(monthInWords('2026-12')).toBe('December 2026');
  });

  it('steps over the end of a year, both ways', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(addMonths('2026-06', 0)).toBe('2026-06');
    expect(addMonths('2026-03', -15)).toBe('2024-12');
    expect(addMonths('2026-03', 22)).toBe('2028-01');
  });

  it('gives the first and last day, in a leap year too', () => {
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2027-04')).toEqual({ from: '2027-04-01', to: '2027-04-30' });
  });

  it('lays a month out in whole weeks, from Monday or from Sunday', () => {
    // December 2026 starts on a Tuesday and ends on a Thursday.
    const monday = monthGrid('2026-12', 'monday');
    expect(monday).toHaveLength(5);
    expect(monday[0]).toEqual([null, '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
    expect(monday[4]).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', null, null, null]);
    const sunday = monthGrid('2026-12', 'sunday');
    expect(sunday[0]).toEqual([null, null, '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05']);
    expect(sunday[1]![0]).toBe('2026-12-06');
    expect(weekOrder('sunday')).toEqual(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
    expect(weekOrder('monday')[0]).toBe('mon');
  });

  it('fits every month into whole weeks with every day once', () => {
    for (let month = '2024-01'; month <= '2028-12'; month = addMonths(month, 1)) {
      for (const start of ['monday', 'sunday'] as const) {
        const weeks = monthGrid(month, start);
        const days = weeks.flat().filter((d): d is string => d !== null);
        const { from, to } = monthRange(month);
        expect(weeks.every((week) => week.length === 7)).toBe(true);
        expect([days[0], days[days.length - 1], days.length]).toEqual([from, to, Number(to.slice(8))]);
        // A month that starts on the first weekday has no empty week before it; nor one after.
        expect(weeks[0]!.some((d) => d !== null) && weeks[weeks.length - 1]!.some((d) => d !== null)).toBe(true);
      }
    }
  });
});
