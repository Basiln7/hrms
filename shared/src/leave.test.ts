/*
 * Leave: the leave year, what an account is owed, how a balance adds up, how many days a
 * request uses, when it may be sent, who may decide or cancel it, and what approved leave
 * means for one calendar day.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDay, summarize, type DayContext, type HolidayOnDay } from './attendance';
import type { LocalDate } from './dates';
import { exampleA, exampleB } from './exampleRules';
import { effectInWords, hasEffect } from './holidays';
import {
  balanceOf,
  checkLeaveRequest,
  countLeaveDays,
  daysInWords,
  dueEntries,
  EMPTY_ACCOUNT,
  floorToHalf,
  grantDays,
  leaveApprovalVerdict,
  leaveCancelVerdict,
  leaveDatesInWords,
  leaveOnDate,
  leavePendingOn,
  leaveYearLabel,
  leaveYearOf,
  leaveYearRange,
  runLength,
  spansOverlap,
  startingEntry,
  touchedInWords,
  validateLeavePolicy,
  validateLeaveType,
  withDue,
  type AccountEntry,
  type AccountFacts,
  type LeaveBooking,
  type LeaveCheckContext,
  type LeaveRequestInput,
  type LeaveSpan,
  type LeaveType,
  type PolicyEntry,
} from './leave';
import type { OrgNode } from './org';
import type { ScheduleRules } from './schedules';

const ZONE = 'Asia/Kolkata';
const A = exampleA(ZONE); // Monday to Saturday, Sunday off
const B = exampleB(ZONE); // Friday off

/** December 2026: Monday 7, …, Saturday 12, Sunday 13, Monday 14. */
const MON = '2026-12-07';
const TUE = '2026-12-08';
const WED = '2026-12-09';
const THU = '2026-12-10';
const FRI = '2026-12-11';
const SAT = '2026-12-12';
const SUN = '2026-12-13';
const NEXT_MON = '2026-12-14';
const TODAY = '2026-12-01';

const context = (rules: ScheduleRules | null = A, holidays: Record<LocalDate, HolidayOnDay> = {}): DayContext => ({ rulesOn: () => rules, holidayOn: (date) => holidays[date] ?? null, employment: [{ from: '2026-01-01', to: null }] });

const type = (more: Partial<LeaveType> = {}): LeaveType => ({ id: 'lt_casual', name: 'Casual leave', code: 'CL', paid: true, allowHalfDay: true, tone: 'blue', archived: false, createdAt: '', updatedAt: '', ...more });
const CASUAL = type();
const UNPAID = type({ id: 'lt_unpaid', name: 'Unpaid leave', code: 'LOP', paid: false });
const entry = (more: Partial<PolicyEntry> = {}): PolicyEntry => ({ ...startingEntry('lt_casual'), annualDays: 12, ...more });

const grant = (days: number, leaveTypeId = 'lt_casual', kind: AccountEntry['kind'] = 'grant'): AccountEntry => ({ kind, leaveTypeId, days, note: '', by: null, byName: 'Automatic', at: '' });
const booking = (startDate: LocalDate, endDate: LocalDate, more: Partial<LeaveBooking> = {}): LeaveBooking => ({ requestId: `lr_${startDate}`, leaveTypeId: 'lt_casual', startDate, endDate, dayPart: 'full', days: 1, state: 'held', ...more });
const account = (entries: AccountEntry[] = [grant(12)], bookings: LeaveBooking[] = []): AccountFacts => ({ entries, bookings, carried: true });

const ask = (startDate: LocalDate, endDate: LocalDate = startDate, more: Partial<LeaveRequestInput> = {}): LeaveRequestInput => ({ leaveTypeId: 'lt_casual', startDate, endDate, dayPart: 'full', reason: 'A family function', ...more });
const check = (input: LeaveRequestInput, more: Partial<LeaveCheckContext> = {}) =>
  checkLeaveRequest(input, { today: TODAY, startMonth: 1, type: CASUAL, hasPolicy: true, entry: entry(), account: account(), ctx: context(), serviceStart: '2024-06-01', ...more });

describe('the leave year', () => {
  it('is named by the calendar year it starts in', () => {
    expect(leaveYearOf('2026-12-31', 1)).toBe(2026);
    expect(leaveYearOf('2027-01-01', 1)).toBe(2027);
    // A leave year from April: January to March still belong to the year before.
    expect(leaveYearOf('2027-03-31', 4)).toBe(2026);
    expect(leaveYearOf('2027-04-01', 4)).toBe(2027);
  });

  it('runs from the first day of its month to the day before the next one', () => {
    expect(leaveYearRange(2026, 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(leaveYearRange(2026, 4)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(leaveYearRange(2027, 3)).toEqual({ from: '2027-03-01', to: '2028-02-29' });
    expect(leaveYearLabel(2026, 1)).toBe('2026');
    expect(leaveYearLabel(2026, 4)).toBe('Apr 2026 to Mar 2027');
  });
});

describe('kinds of leave and policies', () => {
  it('checks a kind of leave field by field', () => {
    expect(validateLeaveType({ name: 'Casual leave', code: 'CL', paid: true, allowHalfDay: true, tone: 'blue' })).toEqual({});
    expect(Object.keys(validateLeaveType({ name: ' ', code: 'casual leave', paid: true, allowHalfDay: true, tone: 'neon' as never }))).toEqual(['name', 'code', 'tone']);
  });

  it('checks a policy entry by entry, naming each field', () => {
    const types = [{ id: 'lt_casual' }, { id: 'lt_sick' }];
    expect(validateLeavePolicy({ name: 'Standard', approver: 'manager', entries: [entry(), { ...startingEntry('lt_sick'), annualDays: 6.5, backdateDays: 7 }] }, types)).toEqual({});
    expect(validateLeavePolicy({ name: 'Standard', approver: 'manager', entries: [] }, types)).toHaveProperty('entries');
    const bad = validateLeavePolicy(
      { name: 'S', approver: 'someone' as never, entries: [entry({ annualDays: 12.3, carryForwardMax: -1, eligibleAfterDays: 1.5, maxConsecutiveDays: 0, minNoticeDays: 3, backdateDays: 2 }), entry(), { ...startingEntry('lt_gone') }] },
      types,
    );
    expect(Object.keys(bad).sort()).toEqual(['approver', 'entries.lt_casual.annualDays', 'entries.lt_casual.backdateDays', 'entries.lt_casual.carryForwardMax', 'entries.lt_casual.eligibleAfterDays', 'entries.lt_casual.leaveTypeId', 'entries.lt_casual.maxConsecutiveDays', 'entries.lt_gone.leaveTypeId', 'name']);
  });
});

describe('what an account is owed', () => {
  const year = leaveYearRange(2026, 1);
  const due = (facts: AccountFacts, more: Partial<Parameters<typeof dueEntries>[1]> = {}) =>
    dueEntries(facts, { policy: { entries: [entry({ carryForwardMax: 5 })] }, types: [CASUAL], year: 2026, startMonth: 1, today: '2026-06-01', serviceStart: '2024-06-01', previous: null, at: 'now', ...more });

  it('grants the whole allowance to someone who was there on the first day, or whose joining date is unknown', () => {
    expect(grantDays(entry(), '2024-06-01', year)).toBe(12);
    expect(grantDays(entry(), '2026-01-01', year)).toBe(12);
    expect(grantDays(entry(), null, year)).toBe(12);
  });

  it('pro-rates a first year by the months left, the month of joining counted whole, rounded down to half a day', () => {
    expect(grantDays(entry(), '2026-07-15', year)).toBe(6); // July to December: 6 of 12
    expect(grantDays(entry(), '2026-12-31', year)).toBe(1);
    expect(grantDays(entry({ annualDays: 10 }), '2026-09-01', year)).toBe(3); // 10 × 4 ÷ 12 = 3.33
    expect(grantDays(entry({ annualDays: 15 }), '2026-08-10', year)).toBe(6); // 15 × 5 ÷ 12 = 6.25
    expect(grantDays(entry({ annualDays: 21 }), '2026-03-01', year)).toBe(17.5); // 21 × 10 ÷ 12
    // Where the policy does not pro-rate, a joiner gets all of it; someone who joins after the year gets none.
    expect(grantDays(entry({ prorateFirstYear: false }), '2026-07-15', year)).toBe(12);
    expect(grantDays(entry(), '2027-02-01', year)).toBe(0);
    // A leave year from April: someone joining in January has three months of it left.
    expect(grantDays(entry(), '2027-01-20', leaveYearRange(2026, 4))).toBe(3);
    expect(floorToHalf(3.99)).toBe(3.5);
  });

  it('makes the year’s grant once: an account that has one is owed no other, whatever the policy says now', () => {
    const first = due(EMPTY_ACCOUNT);
    expect(first.entries).toMatchObject([{ kind: 'grant', leaveTypeId: 'lt_casual', days: 12, by: null, note: 'Allowance for 2026' }]);
    const stored: AccountFacts = { entries: first.entries, bookings: [], carried: first.carried };
    expect(due(stored).entries).toEqual([]);
    // The policy is made more generous afterwards: the grant already made stays as it was.
    expect(due(stored, { policy: { entries: [entry({ annualDays: 20 })] } }).entries).toEqual([]);
    // A kind of leave added to the policy later gets its grant then, once.
    const added = due(stored, { policy: { entries: [entry(), { ...startingEntry('lt_sick'), annualDays: 6 }] }, types: [CASUAL, type({ id: 'lt_sick', name: 'Sick leave' })] });
    expect(added.entries).toMatchObject([{ kind: 'grant', leaveTypeId: 'lt_sick', days: 6 }]);
  });

  it('grants nothing without a policy, for an archived kind, or for an allowance of zero', () => {
    expect(due(EMPTY_ACCOUNT, { policy: null }).entries).toEqual([]);
    expect(due(EMPTY_ACCOUNT, { types: [type({ archived: true })] }).entries).toEqual([]);
    expect(due(EMPTY_ACCOUNT, { policy: { entries: [entry({ annualDays: 0 })] } }).entries).toEqual([]);
  });

  it('says in the note when a grant was pro-rated', () => {
    expect(due(EMPTY_ACCOUNT, { serviceStart: '2026-07-15' }).entries[0]).toMatchObject({ days: 6, note: 'Allowance for 2026, pro-rated from 15 Jul 2026' });
  });

  it('carries forward what was left, up to the policy’s maximum, and only once', () => {
    const last = account([grant(12)], [booking('2025-03-02', '2025-03-04', { days: 3, state: 'taken' })]); // 9 left
    const owed = due(EMPTY_ACCOUNT, { previous: last });
    expect(owed.entries).toMatchObject([{ kind: 'grant', days: 12 }, { kind: 'carry_forward', days: 5, note: 'Carried forward from 2025' }]);
    expect(owed.carried).toBe(true);
    // Once it has been carried, nothing more comes over, even if last year's account changes.
    expect(due({ entries: owed.entries, bookings: [], carried: true }, { previous: account([grant(40)]) }).entries).toEqual([]);
    // Less than the maximum was left: all of it comes over. A policy that carries nothing brings nothing.
    expect(due(EMPTY_ACCOUNT, { previous: account([grant(2.5)]) }).entries[1]).toMatchObject({ kind: 'carry_forward', days: 2.5 });
    expect(due(EMPTY_ACCOUNT, { previous: last, policy: { entries: [entry()] } }).entries).toHaveLength(1);
  });

  it('does not carry days that a waiting request still holds, or a balance below zero', () => {
    const held = account([grant(4)], [booking('2025-12-01', '2025-12-03', { days: 3, state: 'held' })]);
    expect(due(EMPTY_ACCOUNT, { previous: held }).entries[1]).toMatchObject({ kind: 'carry_forward', days: 1 });
    const overdrawn = account([grant(2)], [booking('2025-12-01', '2025-12-03', { days: 3, state: 'taken' })]);
    expect(due(EMPTY_ACCOUNT, { previous: overdrawn }).entries).toHaveLength(1);
  });

  it('does not carry forward before the year has begun: those days could still be spent in the old year', () => {
    const last = account([grant(12)]);
    const ahead = due(EMPTY_ACCOUNT, { year: 2027, today: '2026-11-20', previous: last });
    expect(ahead.entries).toMatchObject([{ kind: 'grant', days: 12, note: 'Allowance for 2027' }]);
    expect(ahead.carried).toBe(false);
    // On the first day of the year it comes over.
    const begun = due({ entries: ahead.entries, bookings: [], carried: false }, { year: 2027, today: '2027-01-01', previous: last });
    expect(begun.entries).toMatchObject([{ kind: 'carry_forward', days: 5 }]);
    expect(begun.carried).toBe(true);
  });

  it('grants nothing new to the account of a year that is over, but still brings over a carry-forward it never had', () => {
    const lastYear: AccountFacts = { entries: [grant(12)], bookings: [], carried: false };
    const sick = { ...startingEntry('lt_sick'), annualDays: 6 };
    const owed = due(lastYear, { year: 2025, today: '2026-06-01', closed: true, policy: { entries: [entry({ carryForwardMax: 5 }), sick] }, types: [CASUAL, type({ id: 'lt_sick' })], previous: account([grant(3)]) });
    expect(owed.entries).toMatchObject([{ kind: 'carry_forward', leaveTypeId: 'lt_casual', days: 3 }]);
    expect(owed.carried).toBe(true);
  });

  it('reads an account with what it is owed added in', () => {
    const view = withDue(EMPTY_ACCOUNT, { policy: { entries: [entry()] }, types: [CASUAL], year: 2026, startMonth: 1, today: '2026-06-01', serviceStart: null, previous: null, at: 'now' });
    expect(balanceOf(view, 'lt_casual')).toMatchObject({ granted: 12, balance: 12, available: 12 });
  });
});

describe('a balance', () => {
  it('is everything added, less what was taken; what is available also leaves out what waiting requests hold', () => {
    const facts = account(
      [grant(12), grant(3, 'lt_casual', 'carry_forward'), grant(-1.5, 'lt_casual', 'adjustment'), grant(2, 'lt_casual', 'adjustment'), grant(6, 'lt_sick')],
      [booking(MON, TUE, { days: 2, state: 'taken' }), booking(WED, WED, { days: 0.5, dayPart: 'first_half' }), booking(THU, THU, { leaveTypeId: 'lt_sick', state: 'taken' })],
    );
    expect(balanceOf(facts, 'lt_casual')).toEqual({ leaveTypeId: 'lt_casual', granted: 12, carriedForward: 3, adjusted: 0.5, taken: 2, held: 0.5, balance: 13.5, available: 13 });
    expect(balanceOf(facts, 'lt_sick')).toMatchObject({ granted: 6, taken: 1, held: 0, balance: 5, available: 5 });
    expect(balanceOf(facts, 'lt_other')).toMatchObject({ balance: 0, available: 0 });
  });
});

describe('the days a request uses', () => {
  it('counts only the person’s own working days: the weekly off inside the range costs nothing', () => {
    // Employee A has Sunday off: Friday to Monday is three days.
    const forA = countLeaveDays(FRI, NEXT_MON, 'full', context(A));
    expect(forA).toMatchObject({ days: 3, charged: [FRI, SAT, NEXT_MON], notCounted: [{ date: SUN, why: 'weekly_off' }] });
    // Employee B has Friday off: the same dates are three other days.
    expect(countLeaveDays(FRI, NEXT_MON, 'full', context(B))).toMatchObject({ days: 3, charged: [SAT, SUN, NEXT_MON], notCounted: [{ date: FRI, why: 'weekly_off' }] });
  });

  it('does not charge a holiday on their calendar, charges an optional one, and charges a special working day', () => {
    const holidays = { [TUE]: { name: 'Founders’ Day', type: 'company' as const }, [WED]: { name: 'Regional festival', type: 'optional' as const }, [SUN]: { name: 'Stock-taking', type: 'special_working_day' as const } };
    const counted = countLeaveDays(MON, SUN, 'full', context(A, holidays));
    expect(counted.charged).toEqual([MON, WED, THU, FRI, SAT, SUN]);
    expect(counted.notCounted).toEqual([{ date: TUE, why: 'holiday', name: 'Founders’ Day' }]);
  });

  it('counts half a day for a half-day, and nothing where attendance is not counted for them', () => {
    expect(countLeaveDays(MON, MON, 'first_half', context(A)).days).toBe(0.5);
    expect(countLeaveDays(SUN, SUN, 'full', context(A))).toMatchObject({ days: 0, charged: [] });
    expect(countLeaveDays(MON, TUE, 'full', context(null))).toMatchObject({ days: 0, notCounted: [{ date: MON, why: 'not_applicable' }, { date: TUE, why: 'not_applicable' }] });
  });

  it('puts days and dates into words', () => {
    expect([daysInWords(1), daysInWords(0.5), daysInWords(2.5), daysInWords(0), daysInWords(-1)]).toEqual(['1 day', 'half a day', '2.5 days', '0 days', '-1 day']);
    expect(leaveDatesInWords({ startDate: MON, endDate: MON, dayPart: 'full' })).toBe('Monday 7 December');
    expect(leaveDatesInWords({ startDate: MON, endDate: MON, dayPart: 'second_half' })).toBe('Monday 7 December, second half');
    expect(leaveDatesInWords({ startDate: MON, endDate: WED, dayPart: 'full' })).toBe('Monday 7 December to Wednesday 9 December');
  });
});

describe('whether a request may be sent', () => {
  it('passes a sound request, with what it uses and what it leaves', () => {
    const result = check(ask(FRI, NEXT_MON));
    expect(result.errors).toEqual({});
    expect(result).toMatchObject({ leaveYear: 2026, count: { days: 3 }, balance: { available: 12, after: 9, unlimited: false } });
  });

  it('wants a reason when it is sent, and none for a preview', () => {
    expect(check(ask(MON, MON, { reason: 'ok' })).errors).toEqual({ reason: 'Say why, in a few words.' });
    expect(checkLeaveRequest(ask(MON, MON, { reason: '' }), { today: TODAY, startMonth: 1, type: CASUAL, hasPolicy: true, entry: entry(), account: account(), ctx: context(), serviceStart: null }, { reason: false }).errors).toEqual({});
  });

  it('refuses a kind of leave that is unknown, archived, or not in their policy', () => {
    expect(check(ask(MON), { type: null }).errors.leaveTypeId).toBe('Choose a kind of leave.');
    expect(check(ask(MON), { type: type({ archived: true }) }).errors.leaveTypeId).toBe('Choose a kind of leave.');
    expect(check(ask(MON), { entry: null }).errors.leaveTypeId).toBe('Your leave policy does not include Casual leave.');
    expect(check(ask(MON), { hasPolicy: false, entry: null }).errors.leaveTypeId).toMatch(/not on a leave policy/);
  });

  it('refuses dates that make no sense', () => {
    expect(check(ask('2026-02-30')).errors).toHaveProperty('startDate');
    expect(check(ask(TUE, MON)).errors.endDate).toBe('The last day cannot be before the first.');
    expect(check(ask(MON, MON, { dayPart: 'morning' as never })).errors).toHaveProperty('dayPart');
  });

  it('allows a half-day only for a single date, and only for a kind that allows it', () => {
    expect(check(ask(MON, MON, { dayPart: 'first_half' }))).toMatchObject({ errors: {}, count: { days: 0.5 }, balance: { after: 11.5 } });
    expect(check(ask(MON, TUE, { dayPart: 'first_half' })).errors.dayPart).toMatch(/single date/);
    expect(check(ask(MON, MON, { dayPart: 'second_half' }), { type: type({ allowHalfDay: false }) }).errors.dayPart).toBe('Casual leave cannot be taken as a half-day.');
  });

  it('refuses a range that crosses the leave year, a year that is over, and one too far ahead', () => {
    expect(check(ask('2026-12-30', '2027-01-02')).errors.endDate).toMatch(/stays inside one leave year, and a new one starts on Friday 1 January/);
    // With a leave year from April the same dates are inside one year, and March into April is not.
    expect(check(ask('2026-12-30', '2027-01-02'), { startMonth: 4 }).errors).toEqual({});
    expect(check(ask('2027-03-30', '2027-04-02'), { startMonth: 4 }).errors).toHaveProperty('endDate');
    expect(check(ask('2025-12-30'), { entry: entry({ backdateDays: 365 }) }).errors.startDate).toMatch(/leave year is over/);
    expect(check(ask('2028-01-04')).errors.startDate).toMatch(/too far ahead/);
    // Next year can be asked for ahead.
    expect(check(ask('2027-01-04'))).toMatchObject({ errors: {}, leaveYear: 2027 });
  });

  it('refuses dates with no working day in them', () => {
    expect(check(ask(SUN)).errors.startDate).toMatch(/no working day for you/);
    expect(check(ask(MON), { ctx: context(null) }).errors.startDate).toMatch(/no work schedule on those dates/);
    expect(check(ask(TUE), { ctx: context(A, { [TUE]: { name: 'Founders’ Day', type: 'public' } }) }).errors.startDate).toMatch(/no working day/);
  });

  it('holds a kind of leave to its notice, or to how far back it may start', () => {
    const notice = entry({ minNoticeDays: 7 });
    expect(check(ask(MON), { entry: notice }).errors.startDate).toBe('Casual leave has to be asked for 7 days ahead: it can start on Tuesday 8 December at the earliest.');
    expect(check(ask(TUE), { entry: notice }).errors).toEqual({});
    // No notice needed: today is fine, yesterday is not, unless the policy lets it start in the past.
    expect(check(ask(TODAY)).errors).toEqual({});
    expect(check(ask('2026-11-30')).errors.startDate).toBe('Casual leave cannot start on a day that has passed.');
    const sick = entry({ backdateDays: 3 });
    expect(check(ask('2026-11-28'), { entry: sick }).errors).toEqual({});
    expect(check(ask('2026-11-27'), { entry: sick }).errors.startDate).toBe('Casual leave can start up to 3 days back: from Saturday 28 November.');
  });

  it('makes a joiner wait until they are eligible', () => {
    const afterNinety = entry({ eligibleAfterDays: 90 });
    expect(check(ask(MON), { entry: afterNinety, serviceStart: '2026-10-01' }).errors.startDate).toBe('You can take Casual leave from Wednesday 30 December: 90 days after joining.');
    expect(check(ask('2026-12-30'), { entry: afterNinety, serviceStart: '2026-10-01' }).errors).toEqual({});
    expect(check(ask(MON), { entry: afterNinety, serviceStart: null }).errors.startDate).toMatch(/joining date is not recorded/);
    // Without a waiting time the joining date does not matter.
    expect(check(ask(MON), { serviceStart: null }).errors).toEqual({});
  });

  it('refuses dates that overlap leave already asked for or approved, of any kind', () => {
    const facts = account([grant(12)], [booking(TUE, THU, { days: 3, state: 'taken' }), booking(SAT, SAT, { leaveTypeId: 'lt_sick' })]);
    expect(check(ask(MON, TUE), { account: facts }).errors.startDate).toBe('You already have leave approved for Tuesday 8 December to Thursday 10 December.');
    expect(check(ask(THU, FRI), { account: facts }).errors).toHaveProperty('startDate');
    expect(check(ask(WED), { account: facts }).errors).toHaveProperty('startDate');
    expect(check(ask(SAT), { account: facts }).errors.startDate).toBe('You already have leave waiting for approval for Saturday 12 December.');
    expect(check(ask(FRI), { account: facts }).errors).toEqual({});
  });

  it('lets two different halves of one day stand side by side, and not the same half twice', () => {
    const morning = account([grant(12)], [booking(MON, MON, { dayPart: 'first_half', days: 0.5 })]);
    expect(check(ask(MON, MON, { dayPart: 'second_half' }), { account: morning }).errors).toEqual({});
    expect(check(ask(MON, MON, { dayPart: 'first_half' }), { account: morning }).errors).toHaveProperty('startDate');
    expect(check(ask(MON), { account: morning }).errors).toHaveProperty('startDate');
    expect(check(ask(MON, TUE), { account: morning }).errors).toHaveProperty('startDate');
    expect(spansOverlap({ startDate: MON, endDate: MON, dayPart: 'first_half' }, { startDate: MON, endDate: MON, dayPart: 'second_half' })).toBe(false);
    expect(spansOverlap({ startDate: MON, endDate: MON, dayPart: 'first_half' }, { startDate: TUE, endDate: TUE, dayPart: 'first_half' })).toBe(false);
  });

  it('holds a kind of leave to its longest run', () => {
    const three = entry({ maxConsecutiveDays: 3 });
    expect(check(ask(MON, WED), { entry: three }).errors).toEqual({});
    expect(check(ask(MON, THU), { entry: three }).errors.endDate).toBe('Casual leave can be taken for 3 days in a row at most, and this is 4 days.');
    // The weekly off in the middle is not a day of leave: Friday, Saturday and Monday are three.
    expect(check(ask(FRI, NEXT_MON), { entry: three }).errors).toEqual({});
  });

  it('counts leave of the same kind right next to it as one run, so the limit cannot be passed by asking twice', () => {
    const three = entry({ maxConsecutiveDays: 3 });
    const facts = account([grant(12)], [booking(MON, TUE, { days: 2 })]);
    expect(check(ask(WED), { entry: three, account: facts }).errors).toEqual({});
    expect(check(ask(WED, THU), { entry: three, account: facts }).errors.endDate).toMatch(/3 days in a row at most, and with the Casual leave you already have next to these dates this would make 4 days/);
    // Across the weekly off it is still one run: Saturday, then Monday and Tuesday after Sunday off.
    const saturday = account([grant(12)], [booking(SAT, SAT)]);
    expect(runLength({ startDate: NEXT_MON, endDate: '2026-12-16', dayPart: 'full', days: 3 }, saturday.bookings, context())).toBe(4);
    // A working day in between breaks the run, and so does leave of another kind.
    expect(check(ask(THU, FRI), { entry: three, account: facts }).errors).toEqual({});
    const sick = account([grant(12)], [booking(MON, TUE, { days: 2, leaveTypeId: 'lt_sick' })]);
    expect(check(ask(WED, FRI), { entry: three, account: sick }).errors).toEqual({});
    // Runs join on both sides.
    const around = [booking(MON, MON), booking(WED, WED)];
    expect(runLength({ startDate: TUE, endDate: TUE, dayPart: 'full', days: 1 }, around, context())).toBe(3);
  });

  it('refuses more than is available, counting the days that waiting requests hold', () => {
    const facts = account([grant(3)], [booking(TUE, TUE, { state: 'taken' }), booking(THU, THU)]); // 1 available
    expect(check(ask(SAT), { account: facts }).errors).toEqual({});
    const refused = check(ask(FRI, SAT), { account: facts });
    expect(refused.errors.leaveTypeId).toBe('This needs 2 days of Casual leave and you have 1 day available (1 day held by requests still waiting).');
    expect(refused.balance).toEqual({ available: 1, after: -1, unlimited: false });
    expect(check(ask(FRI), { account: account([]) }).errors.leaveTypeId).toMatch(/you have 0 days available/);
  });

  it('lets a balance go below zero only where the policy says so, or for unpaid leave', () => {
    const empty = account([]);
    expect(check(ask(MON, TUE), { account: empty, entry: entry({ allowNegative: true }) })).toMatchObject({ errors: {}, balance: { available: 0, after: -2, unlimited: true } });
    expect(check(ask(MON, TUE, { leaveTypeId: 'lt_unpaid' }), { account: empty, type: UNPAID, entry: startingEntry('lt_unpaid') })).toMatchObject({ errors: {}, balance: { unlimited: true } });
    expect(check(ask(MON, TUE), { account: empty }).errors).toHaveProperty('leaveTypeId');
  });
});

describe('who decides and who cancels', () => {
  const people: OrgNode[] = [
    { id: 'admin', role: 'Admin', managerId: null, status: 'active' },
    { id: 'hr', role: 'HR', managerId: null, status: 'active' },
    { id: 'manager', role: 'Manager', managerId: null, status: 'active' },
    { id: 'lead', role: 'Manager', managerId: 'manager', status: 'active' },
    { id: 'employee', role: 'Employee', managerId: 'lead', status: 'active' },
    { id: 'other', role: 'Employee', managerId: null, status: 'active' },
  ];
  const who = (id: string) => people.find((p) => p.id === id)!;
  const verdict = (approver: string, employeeId: string, approver_: 'manager' | 'hr' = 'manager') => leaveApprovalVerdict(who(approver), { employeeId, approver: approver_ }, people);

  it('follows the rules of every approval: never their own, the manager chain, HR and Admin for anyone else', () => {
    expect(verdict('employee', 'employee')).toBe('own');
    expect(verdict('lead', 'employee')).toBe('allowed');
    expect(verdict('manager', 'employee')).toBe('allowed');
    expect(verdict('lead', 'other')).toBe('not_theirs');
    expect(verdict('hr', 'employee')).toBe('allowed');
    expect(verdict('hr', 'hr')).toBe('own');
    // HR's own request is not a manager's to decide, whoever HR reports to.
    expect(verdict('manager', 'hr')).toBe('not_theirs');
    expect(verdict('admin', 'hr')).toBe('allowed');
  });

  it('keeps a request whose policy says "HR only" away from managers', () => {
    expect(verdict('lead', 'employee', 'hr')).toBe('not_theirs');
    expect(verdict('manager', 'employee', 'hr')).toBe('not_theirs');
    expect(verdict('hr', 'employee', 'hr')).toBe('allowed');
    expect(verdict('admin', 'employee', 'hr')).toBe('allowed');
  });

  const cancel = (actor: string, status: 'pending' | 'approved' | 'rejected' | 'cancelled', today: LocalDate, ownRecord: 'ok' | 'blocked' | 'self_administered' = 'ok', employeeId = 'employee') =>
    leaveCancelVerdict({ employeeId, status, startDate: MON }, who(actor), today, ownRecord);

  it('lets a person cancel their own request while it waits, and after approval until its first day', () => {
    expect(cancel('employee', 'pending', WED)).toEqual({ allowed: true, byHr: false });
    expect(cancel('employee', 'approved', '2026-12-06')).toEqual({ allowed: true, byHr: false });
    expect(cancel('employee', 'approved', MON)).toMatchObject({ allowed: false, hidden: false, reason: 'This leave has already started, so only HR can cancel it now.' });
    expect(cancel('employee', 'rejected', TODAY)).toMatchObject({ allowed: false, reason: 'That request is already rejected.' });
  });

  it('lets HR cancel approved leave at any time, with a reason, and tells them to reject one that is still waiting', () => {
    expect(cancel('hr', 'approved', WED)).toEqual({ allowed: true, byHr: true });
    expect(cancel('admin', 'approved', TODAY)).toEqual({ allowed: true, byHr: true });
    expect(cancel('hr', 'pending', TODAY)).toMatchObject({ allowed: false, hidden: false, reason: expect.stringMatching(/Reject it instead/) });
    expect(cancel('hr', 'cancelled', TODAY)).toMatchObject({ allowed: false, reason: 'That request is already cancelled.' });
  });

  it('shows nobody else that the request exists', () => {
    expect(cancel('manager', 'approved', TODAY)).toMatchObject({ allowed: false, hidden: true });
    expect(cancel('other', 'pending', TODAY)).toMatchObject({ allowed: false, hidden: true });
  });

  it('does not let HR cancel their own leave once it has started, unless nobody else could', () => {
    expect(cancel('hr', 'approved', '2026-12-06', 'blocked', 'hr')).toEqual({ allowed: true, byHr: false });
    expect(cancel('hr', 'approved', WED, 'blocked', 'hr')).toMatchObject({ allowed: false, reason: 'This leave has already started. Ask another HR or Admin to cancel it.' });
    expect(cancel('admin', 'approved', WED, 'self_administered', 'admin')).toEqual({ allowed: true, byHr: true });
  });
});

describe('leave on one calendar day', () => {
  const span = (startDate: LocalDate, endDate: LocalDate, more: Partial<LeaveSpan> = {}): LeaveSpan => ({ startDate, endDate, dayPart: 'full', status: 'approved', name: 'Casual leave', paid: true, ...more });
  const LATER = '2026-12-20T06:00:00.000Z';

  it('covers every date of an approved request, and none of one that is still waiting', () => {
    const spans = [span(TUE, THU), span(SAT, SAT, { status: 'pending' })];
    expect(leaveOnDate(spans, MON)).toBeNull();
    expect(leaveOnDate(spans, TUE)).toEqual({ units: 1, part: 'full', name: 'Casual leave' });
    expect(leaveOnDate(spans, THU)).toMatchObject({ units: 1 });
    expect(leaveOnDate(spans, SAT)).toBeNull();
    expect(leavePendingOn(spans, SAT)).toBe(true);
    expect(leavePendingOn(spans, TUE)).toBe(false);
  });

  it('reads a half-day as half, two halves as a whole day, and says how much is unpaid', () => {
    const morning = span(MON, MON, { dayPart: 'first_half' });
    expect(leaveOnDate([morning], MON)).toEqual({ units: 0.5, part: 'first_half', name: 'Casual leave' });
    const afternoon = span(MON, MON, { dayPart: 'second_half', name: 'Unpaid leave', paid: false });
    expect(leaveOnDate([morning, afternoon], MON)).toEqual({ units: 1, part: 'full', name: 'Casual leave + Unpaid leave', unpaidUnits: 0.5 });
    expect(leaveOnDate([span(MON, TUE, { name: 'Unpaid leave', paid: false })], TUE)).toEqual({ units: 1, part: 'full', name: 'Unpaid leave', unpaidUnits: 1 });
  });

  it('never leaves a day reading Absent inside approved leave, also when a holiday inside it is moved afterwards', () => {
    // Leave from Monday to Thursday was counted with a holiday on Tuesday: three days charged.
    const spans = [span(MON, THU)];
    const read = (ctx: DayContext) => [MON, TUE, WED, THU].map((date) => evaluateDay(date, LATER, ctx, { record: null, leave: leaveOnDate(spans, date) }).status);
    const withHoliday = context(A, { [TUE]: { name: 'Founders’ Day', type: 'company' } });
    expect(countLeaveDays(MON, THU, 'full', withHoliday).days).toBe(3);
    expect(read(withHoliday)).toEqual(['leave', 'holiday', 'leave', 'leave']);
    // The holiday is moved to Friday. Tuesday is a working day again, and it reads Leave, not Absent.
    expect(read(context(A, { [FRI]: { name: 'Founders’ Day', type: 'company' } }))).toEqual(['leave', 'leave', 'leave', 'leave']);
  });

  it('adds leave to the month, paid and unpaid apart, and marks a day with a request still waiting', () => {
    const spans = [span(MON, MON), span(TUE, TUE, { name: 'Unpaid leave', paid: false }), span(WED, WED, { dayPart: 'first_half', name: 'Unpaid leave', paid: false }), span(THU, THU, { status: 'pending' })];
    const days = [MON, TUE, WED, THU].map((date) => evaluateDay(date, LATER, context(), { record: null, leave: leaveOnDate(spans, date), pendingLeave: leavePendingOn(spans, date) }));
    expect(days.map((d) => d.status)).toEqual(['leave', 'leave', 'absent', 'absent']);
    expect(days[0]!.leave).toEqual({ units: 1, part: 'full', name: 'Casual leave' });
    expect(days[3]!.flags).toEqual(['pending_leave']);
    expect(summarize(days)).toMatchObject({ workingDays: 4, leaveDays: 2.5, unpaidLeaveDays: 1.5, absentDays: 1.5 });
  });

  it('is not leave on a day off: nothing is marked and nothing is counted', () => {
    const sunday = evaluateDay(SUN, LATER, context(), { record: null, leave: leaveOnDate([span(SAT, NEXT_MON)], SUN), pendingLeave: true });
    expect(sunday).toMatchObject({ status: 'weekly_off', leave: null, flags: [], units: null });
  });
});

describe('leave requests a change touches', () => {
  const touched = { employeeName: 'Arjun Das', typeName: 'Casual leave', startDate: MON, endDate: WED, dayPart: 'full' as const, days: 3, status: 'approved' as const };

  it('are put into sentences for whoever makes the change', () => {
    expect(touchedInWords([])).toEqual([]);
    expect(touchedInWords([touched])).toEqual([
      'One leave request includes these dates. The days already charged stay as they were counted: adjust the balance by hand where that is no longer right.',
      'Arjun Das: Casual leave, Monday 7 December to Wednesday 9 December (3 days charged, approved).',
    ]);
    expect(touchedInWords([touched, { ...touched, employeeName: 'Divya Thomas', startDate: TUE, endDate: TUE, dayPart: 'first_half', days: 0.5, status: 'pending' }])[2]).toBe('Divya Thomas: Casual leave, Tuesday 8 December, first half (half a day charged, waiting).');
  });

  it('make a holiday change something to confirm, also when no day that has begun changes', () => {
    expect(hasEffect({ people: 0, changes: [] })).toBe(false);
    expect(hasEffect({ people: 0, changes: [], leave: [] })).toBe(false);
    const effect = { people: 0, changes: [], leave: [touched] };
    expect(hasEffect(effect)).toBe(true);
    expect(effectInWords(effect)).toHaveLength(2);
    expect(effectInWords({ people: 1, changes: [{ date: TUE, from: 'absent', to: 'holiday', count: 1 }], leave: [touched] })).toHaveLength(4);
  });
});
