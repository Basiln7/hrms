import { describe, expect, it } from 'vitest';
import { WEEKDAYS } from './dates';
import { exampleA, exampleB, exampleC } from './exampleRules';
import {
  assignmentOn,
  breakDeducted,
  dayList,
  describeRules,
  formatMinutes,
  hoursFor,
  isOvernight,
  rulesHeadline,
  shiftTime,
  spanMinutes,
  startBlocker,
  startingRules,
  tidyRules,
  validateRules,
  workingDays,
  type BreakRule,
  type ScheduleRules,
} from './schedules';

const ZONE = 'Asia/Kolkata';
const A = exampleA(ZONE);
const B = exampleB(ZONE);
const C = exampleC(ZONE);
const text = (rules: ScheduleRules) => describeRules(rules).map((l) => l.text);
const problems = (rules: ScheduleRules) => Object.keys(validateRules(rules)).sort();
/** A with something changed. */
const withA = (change: Partial<ScheduleRules>): ScheduleRules => ({ ...A, ...change });

describe('the brief’s three employees', () => {
  it('are all sound sets of rules', () => {
    expect(validateRules(A)).toEqual({});
    expect(validateRules(B)).toEqual({});
    expect(validateRules(C)).toEqual({});
  });

  it('each have their own hours, weekly off and grace', () => {
    expect(hoursFor(A, 'mon')).toMatchObject({ start: '09:00', end: '18:00' });
    expect(hoursFor(A, 'sun')).toBeNull();
    expect(A.lateGraceMinutes).toBe(10);
    expect(workingDays(A)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

    expect(hoursFor(B, 'mon')).toMatchObject({ start: '10:00', end: '19:00' });
    expect(hoursFor(B, 'fri')).toBeNull();
    expect(hoursFor(B, 'sun')).not.toBeNull();
    expect(B.lateGraceMinutes).toBe(5);

    expect(hoursFor(C, 'mon')).toMatchObject({ start: null, end: null, requiredMinutes: 480 });
    expect(hoursFor(C, 'fri')).toMatchObject({ requiredMinutes: 240, fullDayMinutes: 240, halfDayMinutes: 120 });
    expect(hoursFor(C, 'sat')).toBeNull();
    expect(workingDays(C)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
  });

  it('read correctly in plain words', () => {
    expect(text(A)).toEqual(
      expect.arrayContaining([
        'Works Monday to Saturday, 09:00 to 18:00, on Asia/Kolkata time.',
        'Off on Sunday.',
        'Arriving up to 09:10 is on time. From 09:11 it is a late entry.',
        'Check-in opens at 06:00, 3 h before the start.',
        'A full day needs 7 h 30 min of work and half a day 4 h. Less than 4 h does not count as a day.',
        'Break: 1 h is taken off the time worked, once the day goes beyond 5 h.',
        'Arriving at 09:10 and leaving at 18:00 is 7 h 50 min of work: a full day.',
        'Leaving before 18:00 is marked as an early departure.',
      ]),
    );
    expect(text(B)).toEqual(expect.arrayContaining(['Off on Friday.', 'Arriving up to 10:05 is on time. From 10:06 it is a late entry.']));
    expect(text(C)).toEqual(
      expect.arrayContaining([
        'Works Monday to Thursday, any hours, 8 h expected, on Asia/Kolkata time.',
        'Friday is different: any hours, 4 h expected.',
        'Off on Saturday and Sunday.',
        'Breaks are recorded with the Break button and taken off the time worked.',
      ]),
    );
    // A flexible schedule has no start, so nothing is said about being late or leaving early.
    expect(text(C).join(' ')).not.toMatch(/late entry|early departure|Check-in opens/);
    expect(describeRules(A).some((l) => l.warn)).toBe(false);
    expect(rulesHeadline(A)).toBe('09:00 to 18:00 · Monday to Saturday');
    expect(rulesHeadline(C)).toBe('Flexible, 8 h a day · Monday to Friday');
  });
});

describe('the plain-words summary', () => {
  it('warns when arriving on time and leaving on time would not be a full day', () => {
    // The mistake the plan describes: the full-day threshold equal to the required hours.
    const strict = withA({ standard: { ...A.standard, fullDayMinutes: 480 } });
    const warning = describeRules(strict).find((l) => l.warn);
    expect(warning?.text).toBe('Arriving at 09:10 (on time) and leaving at 18:00 is 7 h 50 min of work: only half a day. Lower the full-day threshold or the grace if that is not what you mean.');
  });

  it('says an overnight shift belongs to the day it starts on', () => {
    const night = withA({ standard: { start: '22:00', end: '06:00', requiredMinutes: 420, fullDayMinutes: 400, halfDayMinutes: 210 } });
    expect(validateRules(night)).toEqual({});
    expect(text(night)).toEqual(expect.arrayContaining(['The shift runs past midnight. The whole of it counts for the day it starts on.', 'Check-in opens at 19:00, 3 h before the start.']));
  });

  it('describes each way of handling breaks, corrections and missing check-outs', () => {
    expect(text(withA({ break: { mode: 'none', minutes: 0, appliesAfter: 0 } }))).toContain('No break is taken off the time worked.');
    expect(text(withA({ break: { mode: 'tracked', minutes: 45, appliesAfter: 240 } }))).toContain('Breaks are recorded with the Break button and taken off as taken: at least 45 min, once the day goes beyond 4 h.');
    expect(text(withA({ corrections: { windowDays: 0, maxPerMonth: null } }))).toContain('Employees cannot ask for attendance corrections themselves.');
    expect(text(withA({ corrections: { windowDays: 3, maxPerMonth: 2 } }))).toContain('Employees can ask for a correction up to 3 days back, at most 2 a month.');
    expect(text(withA({ missingCheckOut: { closeAfterMinutes: 720, countsAs: 'absent' } }))).toContain('A day with no check-out can still be closed for 12 h after check-in, or until check-in opens for the next working day. After that it is counted as absent.');
    expect(text(C)).toContain('A day with no check-out can still be closed for 16 h after check-in, or until midnight, when a flexible day ends. After that it is unresolved until it is corrected.');
    expect(text(withA({ lateGraceMinutes: 0 }))).toContain('Arriving after 09:00 is a late entry.');
    expect(text(withA({ offDayWork: 'blocked' }))).toContain('Checking in on a day off or a holiday is not allowed.');
  });

  it('lists days the way a person would', () => {
    expect(dayList(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Monday to Friday');
    expect(dayList(['sat', 'sun'])).toBe('Saturday and Sunday');
    expect(dayList(['mon', 'wed', 'fri'])).toBe('Monday, Wednesday and Friday');
    // The week goes round: everything but Friday is one run, starting on Saturday.
    expect(dayList(['mon', 'tue', 'wed', 'thu', 'sat', 'sun'])).toBe('Saturday to Thursday');
    expect(dayList(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).toBe('Monday to Saturday');
    expect(dayList(['sun', 'mon', 'tue'])).toBe('Sunday to Tuesday');
    expect(dayList(['mon', 'tue', 'thu', 'fri'])).toBe('Monday, Tuesday, Thursday and Friday');
    expect(rulesHeadline(B)).toBe('10:00 to 19:00 · Saturday to Thursday');
    expect(dayList(['fri'])).toBe('Friday');
    expect(dayList([...WEEKDAYS])).toBe('every day');
    expect(dayList([])).toBe('no day');
    // Given out of order, read in the order of the week.
    expect(dayList(['sun', 'sat'])).toBe('Saturday and Sunday');
  });
});

describe('checking a set of rules', () => {
  it('accepts where a new schedule starts, once it has a name', () => {
    expect(problems(startingRules(ZONE))).toEqual(['name']);
    expect(validateRules({ ...startingRules(ZONE), name: 'Office hours' })).toEqual({});
  });

  it('wants a name and a real time zone', () => {
    expect(problems(withA({ name: ' ' }))).toEqual(['name']);
    expect(problems(withA({ name: 'x'.repeat(81) }))).toEqual(['name']);
    expect(problems(withA({ timeZone: 'India' }))).toEqual(['timeZone']);
  });

  it('keeps half a day within a full day, and a full day within the hours expected', () => {
    expect(problems(withA({ standard: { ...A.standard, halfDayMinutes: 460 } }))).toEqual(['standard.halfDayMinutes']);
    expect(problems(withA({ standard: { ...A.standard, fullDayMinutes: 481 } }))).toEqual(['standard.fullDayMinutes']);
    expect(problems(withA({ standard: { ...A.standard, halfDayMinutes: 0 } }))).toEqual(['standard.halfDayMinutes']);
    expect(problems(withA({ standard: { ...A.standard, requiredMinutes: 7.5 } }))).toEqual(['standard.requiredMinutes']);
    // Equal thresholds are allowed: it is a choice, and the summary warns about what it means.
    expect(validateRules(withA({ standard: { ...A.standard, fullDayMinutes: 480, halfDayMinutes: 480 } }))).toEqual({});
  });

  it('needs a start and an end for fixed hours, and none for flexible', () => {
    expect(problems(withA({ standard: { ...A.standard, start: null } }))).toEqual(['standard.start']);
    expect(problems(withA({ standard: { ...A.standard, end: '25:00' } }))).toEqual(['standard.end']);
    expect(problems(withA({ standard: { ...A.standard, end: '09:00' } }))).toEqual(['standard.end']);
    expect(problems({ ...C, standard: { ...C.standard, start: '09:00', end: '17:00' } })).toEqual(['standard.start']);
    expect(problems({ ...C, lateGraceMinutes: 10 })).toEqual(['lateGraceMinutes']);
    expect(problems({ ...C, earlyLeave: { tracked: true, graceMinutes: 0 } })).toEqual(['earlyLeave.tracked']);
  });

  it('makes the hours expected and the break fit between start and end', () => {
    // 09:00 to 18:00 is 9 hours: 8 h 20 expected and a 1 h break do not fit.
    const errors = validateRules(withA({ standard: { ...A.standard, requiredMinutes: 500, fullDayMinutes: 450 } }));
    expect(Object.keys(errors)).toEqual(['standard.requiredMinutes']);
    expect(errors['standard.requiredMinutes']).toContain('1 h break');
    // Exactly fitting is fine.
    expect(validateRules(withA({ standard: { ...A.standard, requiredMinutes: 480 } }))).toEqual({});
    // With breaks recorded by the employee only the hours themselves have to fit.
    expect(validateRules(withA({ break: { mode: 'tracked', minutes: 60, appliesAfter: 300 }, standard: { ...A.standard, requiredMinutes: 540, fullDayMinutes: 500 } }))).toEqual({});
  });

  it('checks a day with hours of its own, and names it', () => {
    const friday = { start: '09:00', end: '13:00', requiredMinutes: 240, fullDayMinutes: 230, halfDayMinutes: 120 };
    // Four hours with a one-hour break allowance: the break rule only bites beyond 5 h, but the allowance must still fit.
    expect(problems(withA({ days: { ...A.days, fri: friday } }))).toEqual(['days.fri.requiredMinutes']);
    expect(validateRules(withA({ days: { ...A.days, fri: { ...friday, requiredMinutes: 180, fullDayMinutes: 170, halfDayMinutes: 90 } } }))).toEqual({});
    expect(problems(withA({ days: { ...A.days, fri: { ...friday, requiredMinutes: 180, fullDayMinutes: 170, halfDayMinutes: 90, end: null } } }))).toEqual(['days.fri.end']);
  });

  it('needs at least one working day', () => {
    const none = Object.fromEntries(WEEKDAYS.map((d) => [d, 'off'])) as ScheduleRules['days'];
    expect(problems(withA({ days: none }))).toEqual(['days']);
  });

  it('checks the break', () => {
    expect(problems(withA({ break: { mode: 'fixed', minutes: 0, appliesAfter: 300 } }))).toEqual(['break.minutes']);
    expect(problems(withA({ break: { mode: 'fixed', minutes: 60, appliesAfter: -1 } }))).toEqual(['break.appliesAfter']);
    expect(problems(withA({ break: { mode: 'sometimes' as never, minutes: 60, appliesAfter: 0 } }))).toEqual(['break.mode']);
    expect(validateRules(withA({ break: { mode: 'tracked', minutes: 0, appliesAfter: 0 } }))).toEqual({});
  });

  it('does not let check-in open while the day before can still be running', () => {
    const long = { start: '08:00', end: '20:00', requiredMinutes: 600, fullDayMinutes: 570, halfDayMinutes: 300 };
    expect(problems(withA({ standard: long, earlyCheckInMinutes: 720 }))).toEqual(['earlyCheckInMinutes']);
    // 12 h day + 11 h early + 1 h to check out is exactly a day.
    expect(validateRules(withA({ standard: long, earlyCheckInMinutes: 660 }))).toEqual({});
  });

  it('gives a day long enough to be closed', () => {
    const errors = validateRules(withA({ missingCheckOut: { closeAfterMinutes: 480, countsAs: 'unresolved' } }));
    expect(Object.keys(errors)).toEqual(['missingCheckOut.closeAfterMinutes']);
    expect(errors['missingCheckOut.closeAfterMinutes']).toContain('9 h');
    expect(problems(withA({ missingCheckOut: { closeAfterMinutes: 30, countsAs: 'unresolved' } }))).toEqual(['missingCheckOut.closeAfterMinutes']);
    expect(problems(withA({ missingCheckOut: { closeAfterMinutes: 960, countsAs: 'present' as never } }))).toEqual(['missingCheckOut.countsAs']);
  });

  it('checks the correction limits', () => {
    expect(problems(withA({ corrections: { windowDays: 91, maxPerMonth: null } }))).toEqual(['corrections.windowDays']);
    expect(problems(withA({ corrections: { windowDays: 7, maxPerMonth: 0 } }))).toEqual(['corrections.maxPerMonth']);
    expect(validateRules(withA({ corrections: { windowDays: 0, maxPerMonth: 5 } }))).toEqual({});
  });

  it('stores only what means something for the kind of schedule', () => {
    const messy: ScheduleRules = { ...A, name: '  Flexi  ', kind: 'flexible', break: { mode: 'none', minutes: 60, appliesAfter: 300 } };
    const tidy = tidyRules(messy);
    expect(tidy).toMatchObject({
      name: 'Flexi',
      standard: { start: null, end: null, requiredMinutes: 480 },
      break: { mode: 'none', minutes: 0, appliesAfter: 0 },
      lateGraceMinutes: 0,
      earlyCheckInMinutes: 0,
      earlyLeave: { tracked: false, graceMinutes: 0 },
    });
    expect(validateRules(tidy)).toEqual({});
    // Tidying sound fixed rules changes nothing.
    expect(tidyRules(A)).toEqual(A);
    expect(tidyRules(C)).toEqual(C);
  });
});

describe('hours and breaks', () => {
  it('measures a day, also past midnight', () => {
    expect(spanMinutes(A.standard)).toBe(540);
    expect(spanMinutes({ ...A.standard, start: '22:00', end: '06:00' })).toBe(480);
    expect(spanMinutes({ ...A.standard, start: '00:00', end: '08:00' })).toBe(480);
    expect(spanMinutes(C.standard)).toBe(0);
    expect(isOvernight(A.standard)).toBe(false);
    expect(isOvernight({ ...A.standard, start: '22:00', end: '06:00' })).toBe(true);
    expect(isOvernight(C.standard)).toBe(false);
  });

  const fixed: BreakRule = { mode: 'fixed', minutes: 60, appliesAfter: 300 };

  it('takes a fixed break only from time beyond the line, minute for minute', () => {
    expect(breakDeducted(fixed, 120)).toBe(0);
    expect(breakDeducted(fixed, 300)).toBe(0);
    expect(breakDeducted(fixed, 301)).toBe(1);
    expect(breakDeducted(fixed, 320)).toBe(20);
    expect(breakDeducted(fixed, 360)).toBe(60);
    expect(breakDeducted(fixed, 540)).toBe(60);
    expect(breakDeducted({ mode: 'fixed', minutes: 60, appliesAfter: 0 }, 30)).toBe(30);
  });

  it('never lets staying longer reduce the time worked', () => {
    for (const rule of [fixed, { mode: 'fixed', minutes: 90, appliesAfter: 0 }, { mode: 'tracked', minutes: 45, appliesAfter: 240 }] as BreakRule[]) {
      let previous = 0;
      for (let gross = 0; gross <= 900; gross += 1) {
        const worked = gross - breakDeducted(rule, gross);
        expect(worked, `${rule.mode} at ${gross}`).toBeGreaterThanOrEqual(previous);
        previous = worked;
      }
    }
  });

  it('takes tracked breaks as taken, and never less than the allowance', () => {
    const tracked: BreakRule = { mode: 'tracked', minutes: 60, appliesAfter: 300 };
    expect(breakDeducted(tracked, 540, 0)).toBe(60);
    expect(breakDeducted(tracked, 540, 20)).toBe(60);
    expect(breakDeducted(tracked, 540, 90)).toBe(90);
    expect(breakDeducted(tracked, 200, 0)).toBe(0);
    expect(breakDeducted(tracked, 200, 15)).toBe(15);
    expect(breakDeducted({ mode: 'tracked', minutes: 0, appliesAfter: 0 }, 525, 45)).toBe(45);
    // A break can never be longer than the day it is in.
    expect(breakDeducted(tracked, 30, 50)).toBe(30);
    expect(breakDeducted({ mode: 'none', minutes: 60, appliesAfter: 0 }, 540, 45)).toBe(0);
  });

  it('writes durations and moves times', () => {
    expect(formatMinutes(450)).toBe('7 h 30 min');
    expect(formatMinutes(480)).toBe('8 h');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(0)).toBe('0 min');
    expect(shiftTime('09:00', 10)).toBe('09:10');
    expect(shiftTime('09:00', -180)).toBe('06:00');
    expect(shiftTime('23:55', 10)).toBe('00:05');
    expect(shiftTime('00:00', -180)).toBe('21:00');
  });
});

describe('the rules on a date', () => {
  const history = [
    { id: 'third', effectiveFrom: '2027-03-01' },
    { id: 'first', effectiveFrom: '2026-12-01' },
    { id: 'second', effectiveFrom: '2027-01-15' },
  ];

  it('are those of the latest assignment that has started by then', () => {
    expect(assignmentOn(history, '2026-11-30')).toBeNull();
    expect(assignmentOn(history, '2026-12-01')?.id).toBe('first');
    expect(assignmentOn(history, '2027-01-14')?.id).toBe('first');
    expect(assignmentOn(history, '2027-01-15')?.id).toBe('second');
    expect(assignmentOn(history, '2027-02-28')?.id).toBe('second');
    expect(assignmentOn(history, '2027-03-01')?.id).toBe('third');
    expect(assignmentOn(history, '2030-01-01')?.id).toBe('third');
    expect(assignmentOn([], '2026-12-01')).toBeNull();
  });

  it('do not change for an earlier date when a later assignment is added', () => {
    const before = ['2026-12-01', '2026-12-25', '2027-01-14'].map((d) => assignmentOn(history.slice(1), d)?.id);
    const after = ['2026-12-01', '2026-12-25', '2027-01-14'].map((d) => assignmentOn([...history, { id: 'fourth', effectiveFrom: '2027-06-01' }], d)?.id);
    expect(after).toEqual(before);
  });
});

describe('when an assignment may start', () => {
  const today = '2026-11-23';

  it('lets a first schedule start today or later, never before', () => {
    expect(startBlocker('2026-11-23', today, false)).toBeNull();
    expect(startBlocker('2026-12-01', today, false)).toBeNull();
    expect(startBlocker('2026-11-22', today, false)).toMatch(/Nothing is back-dated/);
    expect(startBlocker('2019-04-01', today, false)).toMatch(/Nothing is back-dated/);
  });

  it('lets a change start tomorrow or later, never on a day that has begun', () => {
    expect(startBlocker('2026-11-24', today, true)).toBeNull();
    expect(startBlocker('2026-11-23', today, true)).toMatch(/tomorrow at the earliest/);
    expect(startBlocker('2026-11-01', today, true)).toMatch(/tomorrow at the earliest/);
  });

  it('refuses a date that is not one, or too far off', () => {
    expect(startBlocker('2026-02-30', today, false)).toMatch(/Choose the date/);
    expect(startBlocker('', today, true)).toMatch(/Choose the date/);
    expect(startBlocker('2027-11-24', today, true)).toBeNull();
    expect(startBlocker('2027-11-25', today, true)).toMatch(/within the next year/);
  });
});
