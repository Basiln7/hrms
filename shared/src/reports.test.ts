/*
 * The overview's groups, the records' filters, late frequency, and reports written out as
 * rows and as CSV. The days themselves are read by the engine, as everywhere else.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDay, summarize, type DayContext, type DayFacts, type DayInput, type DayResult, type DayStatus } from './attendance';
import { csvCell, toCsv } from './csv';
import { zonedToInstant, type LocalDate } from './dates';
import { exampleA } from './exampleRules';
import { addSummaries, countOverview, employeeRows, hoursOf, inOverview, inRecords, lateCount, monthlyRows, OVERVIEW_FILTERS, OVERVIEW_GROUPS, OVERVIEW_INFO, overviewGroupOf, recordRows } from './reports';

const ZONE = 'Asia/Kolkata';
const A = exampleA(ZONE);
/** Monday 7 to Sunday 13 December 2026. */
const [MON, TUE, WED, THU, FRI, SAT, SUN] = ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13'];
const at = (date: LocalDate, time: string) => zonedToInstant(date, time, ZONE).toISOString();

const ctx: DayContext = { rulesOn: () => A, holidayOn: (date) => (date === THU ? { name: 'Founders’ Day', type: 'company' } : null), employment: [{ from: '2026-12-01', to: null }] };
const punched = (date: LocalDate, inTime: string, outTime: string | null, more: Partial<DayFacts> = {}): DayInput => ({ record: { rules: A, checkInAt: at(date, inTime), checkOutAt: outTime ? at(date, outTime) : null, breaks: [], override: null, lateExcused: false, ...more } });
const read = (date: LocalDate, now: string, input: DayInput = { record: null }) => evaluateDay(date, now, ctx, input);

/** A week as it reads on the Wednesday at 11:00, and one person per kind of day. */
const NOW = at(WED, '11:00');
const days: Record<string, DayResult> = {
  present: read(MON, NOW, punched(MON, '09:00', '18:00')),
  lateHalf: read(MON, NOW, punched(MON, '09:40', '14:30')),
  absent: read(TUE, NOW),
  unresolved: read(MON, NOW, punched(MON, '09:00', null)),
  working: read(WED, NOW, punched(WED, '09:05', null)),
  lateWorking: read(WED, NOW, punched(WED, '10:30', null)),
  notIn: read(WED, NOW),
  notDue: read(WED, at(WED, '08:00')),
  leave: read(TUE, NOW, { record: null, leave: { units: 1, part: 'full', name: 'Casual leave' } }),
  holiday: read(THU, at(FRI, '11:00')),
  weeklyOff: read(SUN, at('2026-12-14', '11:00')),
  upcoming: read(FRI, NOW),
  notCounted: evaluateDay('2026-11-20', NOW, ctx),
};

describe('the overview of a day', () => {
  it('puts every status into exactly one group', () => {
    const statuses: DayStatus[] = ['not_applicable', 'upcoming', 'not_due', 'not_in', 'working', 'on_break', 'present', 'half_day', 'absent', 'leave', 'holiday', 'weekly_off', 'unresolved'];
    expect(statuses.map((status) => overviewGroupOf({ status }))).toEqual(['not_counted', 'upcoming', 'not_due', 'absent', 'working', 'working', 'present', 'half_day', 'absent', 'leave', 'day_off', 'day_off', 'unresolved']);
    expect(OVERVIEW_FILTERS.every((filter) => OVERVIEW_INFO[filter].label.length > 0)).toBe(true);
  });

  it('reads the sample days as the engine does', () => {
    expect(Object.fromEntries(Object.entries(days).map(([name, day]) => [name, overviewGroupOf(day)]))).toEqual({
      present: 'present',
      lateHalf: 'half_day',
      absent: 'absent',
      unresolved: 'unresolved',
      working: 'working',
      lateWorking: 'working',
      notIn: 'absent',
      notDue: 'not_due',
      leave: 'leave',
      holiday: 'day_off',
      weeklyOff: 'day_off',
      upcoming: 'upcoming',
      notCounted: 'not_counted',
    });
  });

  it('counts each person once among the groups, and "checked in" and "late" across them', () => {
    const all = Object.values(days);
    const counts = countOverview(all);
    expect(counts).toEqual({ all: 13, checked_in: 5, late: 2, working: 2, present: 1, half_day: 1, absent: 2, unresolved: 1, leave: 1, day_off: 2, not_due: 1, upcoming: 1, not_counted: 1 });
    // The groups add up to everyone: nobody is counted twice and nobody is left out.
    expect(OVERVIEW_GROUPS.reduce((sum, group) => sum + counts[group], 0)).toBe(all.length);
    expect(all.filter((day) => inOverview(day, 'late')).map((day) => day.lateMinutes)).toEqual([40, 90]);
  });
});

describe('attendance records', () => {
  it('lists every day there is something to say about, and no day still to come or not counted', () => {
    const listed = Object.entries(days)
      .filter(([, day]) => inRecords(day))
      .map(([name]) => name);
    // A holiday and a weekly off on which nothing happened are not listed unless asked for.
    expect(listed).toEqual(['present', 'lateHalf', 'absent', 'unresolved', 'working', 'lateWorking', 'notIn', 'notDue', 'leave']);
    expect(inRecords(days.holiday!, { status: 'holiday' })).toBe(true);
    expect(inRecords(days.weeklyOff!, { status: 'weekly_off' })).toBe(true);
    expect(inRecords(days.upcoming!, { status: 'present' })).toBe(false);
    // Work on a day off is something to say.
    const sundayWorked = read(SUN, at('2026-12-14', '11:00'), punched(SUN, '10:00', '13:00'));
    expect(sundayWorked.flags).toContain('worked_on_off_day');
    expect(inRecords(sundayWorked)).toBe(true);
    expect(inRecords(sundayWorked, { flag: 'worked_on_off_day' })).toBe(true);
  });

  it('narrows by status and by mark, together or apart', () => {
    const names = (filter: Parameters<typeof inRecords>[1]) =>
      Object.entries(days)
        .filter(([, day]) => inRecords(day, filter))
        .map(([name]) => name);
    expect(names({ status: 'absent' })).toEqual(['absent']);
    expect(names({ status: 'not_in' })).toEqual(['notIn']);
    expect(names({ status: 'working' })).toEqual(['working', 'lateWorking']);
    expect(names({ flag: 'late' })).toEqual(['lateHalf', 'lateWorking']);
    expect(names({ flag: 'late', status: 'half_day' })).toEqual(['lateHalf']);
    expect(names({ flag: 'early_departure' })).toEqual(['lateHalf']);
    expect(names({ status: 'leave' })).toEqual(['leave']);
  });

  it('counts how often and by how much someone was late, excused or not', () => {
    const excused = read(TUE, NOW, punched(TUE, '09:25', '18:30', { lateExcused: true }));
    expect(lateCount([days.present!, days.lateHalf!, days.lateWorking!, excused])).toEqual({ entries: 3, excused: 1, minutes: 40 + 90 + 25 });
    expect(lateCount([days.present!, days.absent!])).toEqual({ entries: 0, excused: 0, minutes: 0 });
  });
});

describe('writing CSV', () => {
  it('writes text as it is, numbers as numbers, and nothing for what is missing', () => {
    expect(['Arjun Das', 12, 7.5, 0, null, undefined, Number.NaN].map(csvCell)).toEqual(['Arjun Das', '12', '7.5', '0', '', '', '']);
  });

  it('quotes a cell with a comma, a quote, a line break or space at an end', () => {
    expect(csvCell('Das, Arjun')).toBe('"Das, Arjun"');
    expect(csvCell('He said "no"')).toBe('"He said ""no"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(' padded ')).toBe('" padded "');
  });

  it('makes a cell that starts like a formula safe, whoever typed it', () => {
    expect(csvCell('=HYPERLINK("http://evil.example","Click")')).toBe('"\'=HYPERLINK(""http://evil.example"",""Click"")"');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+91 98470 12345')).toBe("'+91 98470 12345");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvCell('\t=cmd')).toBe("'\t=cmd");
    // A number that is negative is a number, not a formula; text that merely contains a sign is left alone.
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell('Half-day')).toBe('Half-day');
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('writes a file a spreadsheet reads as UTF-8, row by row', () => {
    expect(toCsv([['Name', 'Days'], ['അർജുൻ', 2]])).toBe('﻿Name,Days\r\nഅർജുൻ,2\r\n');
  });
});

describe('reports as rows', () => {
  const week = [
    read(MON, at(SAT, '20:00'), punched(MON, '09:40', '18:30')),
    read(TUE, at(SAT, '20:00'), punched(TUE, '09:00', '14:00')),
    read(WED, at(SAT, '20:00')),
    read(THU, at(SAT, '20:00')),
    read(FRI, at(SAT, '20:00'), { record: null, leave: { units: 1, part: 'full', name: 'Unpaid leave', unpaidUnits: 1 } }),
    read(SAT, at(SAT, '20:00'), punched(SAT, '09:00', null)),
  ];

  it('turns minutes into hours a spreadsheet can add up', () => {
    expect([hoursOf(480), hoursOf(490), hoursOf(0), hoursOf(125)]).toEqual([8, 8.17, 0, 2.08]);
  });

  it('writes one person’s days with their times on the clock of their zone', () => {
    const rows = employeeRows(week, ZONE);
    expect(rows[0]).toEqual(['Date', 'Day', 'Status', 'Notes', 'Check-in', 'Check-out', 'Break (minutes)', 'Worked (hours)', 'Late by (minutes)', 'Left early by (minutes)', 'Holiday', 'Leave']);
    expect(rows[1]).toEqual([MON, 'Monday', 'Present', 'Late by 40 min; Short by 10 min', '09:40', '18:30', 60, 7.83, 40, '', '', '']);
    // Five hours exactly: the fixed break is taken off only once a day goes beyond five.
    expect(rows[2]).toEqual([TUE, 'Tuesday', 'Half-day', 'Left 4 h early; Short by 3 h', '09:00', '14:00', 0, 5, '', 240, '', '']);
    expect(rows[3]).toEqual([WED, 'Wednesday', 'Absent', '', '', '', '', '', '', '', '', '']);
    expect(rows[4]).toEqual([THU, 'Thursday', 'Holiday', '', '', '', '', '', '', '', 'Founders’ Day', '']);
    expect(rows[5]).toEqual([FRI, 'Friday', 'Leave', '', '', '', '', '', '', '', '', 'Unpaid leave']);
    // Still open at 20:00 on the day: no hours are counted for it yet.
    expect(rows[6]!.slice(2, 8)).toEqual(['Working', '', '09:00', '', '', '']);
  });

  it('says so when a check-out is not on the day itself', () => {
    const night = { ...A, standard: { ...A.standard, start: '22:00', end: '06:00' } };
    const nightCtx: DayContext = { ...ctx, rulesOn: () => night, holidayOn: () => null };
    const shift = evaluateDay(MON, at(WED, '12:00'), nightCtx, { record: { rules: night, checkInAt: at(MON, '22:00'), checkOutAt: at(TUE, '06:05'), breaks: [], override: null, lateExcused: false } });
    expect(employeeRows([shift], ZONE)[1]!.slice(4, 6)).toEqual(['22:00', `06:05 (${TUE})`]);
  });

  it('writes the monthly summary with the same numbers as the calendar, and their total', () => {
    const one = summarize(week);
    const two = summarize(week.slice(0, 3));
    const totals = addSummaries([one, two]);
    expect(totals).toMatchObject({ workingDays: one.workingDays + two.workingDays, leaveDays: 1, unpaidLeaveDays: 1, workedMinutes: one.workedMinutes + two.workedMinutes });
    const rows = monthlyRows(
      [
        { code: 'EMP-0004', name: 'Arjun Das', departmentName: 'Sales', summary: one },
        { code: 'EMP-0007', name: '=cmd|calc', departmentName: null, summary: two },
      ],
      totals,
    );
    expect(rows[0]!.slice(0, 5)).toEqual(['Employee code', 'Name', 'Department', 'Working days counted', 'Present']);
    expect(rows[1]).toEqual(['EMP-0004', 'Arjun Das', 'Sales', one.workingDays, one.presentDays, one.halfDays, one.leaveDays, one.unpaidLeaveDays, one.absentDays, one.unresolvedDays, one.lateEntries, one.earlyDepartures, one.correctedDays, one.holidays, one.weeklyOffs, one.offDaysWorked, hoursOf(one.workedMinutes)]);
    expect(rows[3]!.slice(0, 4)).toEqual(['', 'Total', '', totals.workingDays]);
    // Written out, a name that starts like a formula is plain text.
    expect(toCsv(rows).split('\r\n')[2]!.startsWith("EMP-0007,'=cmd|calc,,")).toBe(true);
  });

  it('writes many people’s days with who each is', () => {
    const rows = recordRows([{ code: 'EMP-0004', name: 'Arjun Das', departmentName: 'Sales', timeZone: ZONE, day: week[0]! }]);
    expect(rows[0]!.slice(0, 4)).toEqual(['Employee code', 'Name', 'Department', 'Date']);
    expect(rows[1]!.slice(0, 6)).toEqual(['EMP-0004', 'Arjun Das', 'Sales', MON, 'Monday', 'Present']);
  });
});
