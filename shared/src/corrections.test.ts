/*
 * Attendance corrections: which kinds fit a day, when one may be asked for, whether its times
 * make sense, what the day reads as afterwards, and who may decide. Times are written as the
 * clock on the wall shows them, in the schedule's zone.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDay, summarize, type DayContext, type DayFacts, type LeaveOnDay } from './attendance';
import {
  applyChange,
  approvalVerdict,
  changeInWords,
  changeKind,
  correctionTypesFor,
  decidableBy,
  previewCorrection,
  requestBlocker,
  validateCorrection,
  validateDirectCorrection,
  type CorrectionInput,
  type DayState,
  type DirectCorrectionInput,
} from './corrections';
import { zonedToInstant, type LocalDate } from './dates';
import { exampleA } from './exampleRules';
import type { OrgNode } from './org';
import type { ScheduleRules } from './schedules';

const ZONE = 'Asia/Kolkata';
const A = exampleA(ZONE);
const A_NO_OFF_DAY_WORK: ScheduleRules = { ...A, offDayWork: 'blocked' };

/** Monday 7 to Sunday 13 December 2026. "Now" is Thursday at noon unless a test says otherwise. */
const MON = '2026-12-07';
const TUE = '2026-12-08';
const WED = '2026-12-09';
const THU = '2026-12-10';
const SUN = '2026-12-13';

function at(date: LocalDate, time: string): string {
  const seconds = time.length > 5 ? Number(time.slice(6)) : 0;
  return new Date(zonedToInstant(date, time.slice(0, 5), ZONE).getTime() + seconds * 1000).toISOString();
}
const NOON = at(THU, '12:00');

const context = (rules: ScheduleRules | null = A, employment = [{ from: '2026-12-01', to: null as string | null }]): DayContext => ({ rulesOn: () => rules, holidayOn: () => null, employment });

const punches = (date: LocalDate, inTime: string | null, outTime: string | null = null, more: Partial<DayFacts> = {}): DayFacts => ({ checkInAt: inTime ? at(date, inTime) : null, checkOutAt: outTime ? at(date, outTime) : null, breaks: [], override: null, lateExcused: false, ...more });

/** A day as the correction rules see it, read at a moment. */
function state(date: LocalDate, facts: DayFacts | null, now = NOON, rules: ScheduleRules | null = A, ctx = context(rules)): DayState {
  return { date, facts, rules, day: evaluateDay(date, now, ctx, { record: facts && rules ? { ...facts, rules } : null }) };
}

const ask = (type: CorrectionInput['type'], more: Partial<CorrectionInput> = {}): Omit<CorrectionInput, 'date'> => ({ type, checkIn: null, checkOut: null, status: null, reason: 'Forgot at the client site', ...more });

describe('a status set by an approved correction, with nothing punched', () => {
  const LATER = '2027-01-15T06:00:00.000Z';
  const record = (override: 'present' | 'half_day') => ({ record: { rules: A, ...punches(MON, null), override } });

  it('counts the day as it says, and marks it corrected', () => {
    expect(evaluateDay(MON, LATER, context(), record('present'))).toMatchObject({ status: 'present', flags: ['corrected'], units: { worked: 1, leave: 0, absent: 0, unresolved: 0 }, checkInAt: null, workedMinutes: 0 });
    expect(evaluateDay(MON, LATER, context(), record('half_day'))).toMatchObject({ status: 'half_day', flags: ['corrected'], units: { worked: 0.5, absent: 0.5 } });
  });

  it('never counts more than leave leaves owed, and still adds up to one day', () => {
    const half: LeaveOnDay = { units: 0.5, part: 'first_half' };
    const day = evaluateDay(MON, LATER, context(), { ...record('present'), leave: half });
    expect(day.units).toEqual({ worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 });
    const total = summarize([day, evaluateDay(TUE, LATER, context(), record('half_day')), evaluateDay(WED, LATER, context())]);
    expect(total.presentDays + total.halfDays / 2 + total.leaveDays + total.absentDays + total.unresolvedDays).toBe(total.workingDays);
  });

  it('does not turn a day off into a working day', () => {
    expect(evaluateDay(SUN, LATER, context(), { record: { rules: A, ...punches(SUN, null), override: 'present' } })).toMatchObject({ status: 'weekly_off', units: null });
  });
});

describe('which kinds of correction fit a day', () => {
  it('follows what is recorded and how the day reads', () => {
    // Nothing punched, the day over: absent.
    expect(correctionTypesFor(state(MON, null))).toEqual(['forgot_attendance', 'missing_check_in', 'absent_correction']);
    // In late and out: present and late.
    expect(correctionTypesFor(state(TUE, punches(TUE, '09:26', '18:30')))).toEqual(['incorrect_check_in', 'incorrect_check_out', 'late_explanation']);
    // Left at 14:00: a half-day.
    expect(correctionTypesFor(state(WED, punches(WED, '09:00', '14:00')))).toEqual(['incorrect_check_in', 'incorrect_check_out', 'half_day_correction']);
    // Two hours: counted absent, with punches.
    expect(correctionTypesFor(state(WED, punches(WED, '09:00', '11:00')))).toEqual(['incorrect_check_in', 'incorrect_check_out', 'absent_correction']);
    // Checked in and never out, long past closing: unresolved.
    expect(correctionTypesFor(state(MON, punches(MON, '09:00')))).toEqual(['missing_check_out', 'incorrect_check_in']);
    // The same after a late start: the lateness can be explained as well.
    expect(correctionTypesFor(state(MON, punches(MON, '17:30')))).toEqual(['missing_check_out', 'incorrect_check_in', 'late_explanation']);
  });

  it('does not offer a missing check-out while the day can still be checked out', () => {
    const today = state(THU, punches(THU, '09:00'));
    expect(today.day.status).toBe('working');
    expect(correctionTypesFor(today)).toEqual(['incorrect_check_in']);
  });

  it('offers the explanation of a late entry once', () => {
    expect(correctionTypesFor(state(TUE, punches(TUE, '09:26', '18:30', { lateExcused: true })))).not.toContain('late_explanation');
  });

  it('offers nothing for a half-day already set by hand, and nothing where attendance does not count', () => {
    expect(correctionTypesFor(state(WED, punches(WED, '09:00', '18:00', { override: 'half_day' })))).not.toContain('half_day_correction');
    expect(correctionTypesFor(state(MON, null, NOON, null))).toEqual([]);
    expect(correctionTypesFor(state('2026-11-20', null))).toEqual([]);
  });

  it('corrects a day off only for work done on it, where the schedule records such work', () => {
    const later = at('2026-12-15', '12:00');
    expect(correctionTypesFor(state(SUN, null, later))).toEqual(['forgot_attendance', 'missing_check_in']);
    expect(correctionTypesFor(state(SUN, null, later, A_NO_OFF_DAY_WORK))).toEqual([]);
    // Work that is on record all the same can still be put right.
    expect(correctionTypesFor(state(SUN, punches(SUN, '10:00', '13:00'), later, A_NO_OFF_DAY_WORK))).toEqual(['incorrect_check_in', 'incorrect_check_out']);
  });
});

describe('when a correction may be asked for', () => {
  const limits = { windowDays: 7, maxPerMonth: 2 };

  it('reaches back as far as the schedule says, to the day', () => {
    expect(requestBlocker('2026-12-03', THU, limits, 0, false)).toBeNull();
    expect(requestBlocker('2026-12-02', THU, limits, 0, false)).toBe('Your schedule lets you ask for a correction up to 7 days back: from Thursday 3 December. For an older day, ask HR.');
    expect(requestBlocker(THU, THU, { windowDays: 0, maxPerMonth: null }, 0, false)).toBeNull();
    expect(requestBlocker(WED, THU, { windowDays: 0, maxPerMonth: null }, 0, false)).toMatch(/up to 0 days back/);
    expect(requestBlocker(WED, THU, { windowDays: 1, maxPerMonth: null }, 0, false)).toBeNull();
  });

  it('not for a day still to come, and not twice for the same day at once', () => {
    expect(requestBlocker('2026-12-11', THU, limits, 0, false)).toBe('A day that has not come yet has nothing to correct.');
    expect(requestBlocker(WED, THU, limits, 0, true)).toMatch(/already waiting for a decision/);
  });

  it('stops at the number the schedule allows for the days of one month', () => {
    expect(requestBlocker(WED, THU, limits, 1, false)).toBeNull();
    expect(requestBlocker(WED, THU, limits, 2, false)).toBe('Your schedule allows 2 corrections for the days of one month, and December 2026 already has 2. Ask HR.');
    expect(requestBlocker(WED, THU, { windowDays: 7, maxPerMonth: null }, 40, false)).toBeNull();
  });
});

describe('a request, checked against the day', () => {
  const check = (dayState: DayState, input: Omit<CorrectionInput, 'date'>, now = NOON) => validateCorrection(input, dayState, context(dayState.rules), now);

  it('forgot attendance: both times are set, and the day then reads by its own rules', () => {
    const monday = state(MON, null);
    const { errors, change } = check(monday, ask('forgot_attendance', { checkIn: `${MON}T09:05`, checkOut: `${MON}T18:10` }));
    expect(errors).toEqual({});
    expect(change).toEqual({ checkInAt: at(MON, '09:05'), checkOutAt: at(MON, '18:10') });
    // 9 h 05 less the hour's break: a full day, on time, marked as corrected.
    expect(previewCorrection(monday, change!, context(), NOON)).toMatchObject({ status: 'present', workedMinutes: 485, flags: ['corrected'], units: { worked: 1 } });
  });

  it('missing check-out, incorrect check-in, incorrect check-out: only the time asked for changes', () => {
    expect(check(state(MON, punches(MON, '17:30')), ask('missing_check_out', { checkOut: `${MON}T18:30` })).change).toEqual({ checkOutAt: at(MON, '18:30') });
    const tuesday = state(TUE, punches(TUE, '09:26', '18:30'));
    const earlier = check(tuesday, ask('incorrect_check_in', { checkIn: `${TUE}T09:02` }));
    expect(earlier.change).toEqual({ checkInAt: at(TUE, '09:02') });
    expect(previewCorrection(tuesday, earlier.change!, context(), NOON)).toMatchObject({ status: 'present', lateMinutes: 0, flags: ['corrected'] });
    expect(check(tuesday, ask('incorrect_check_out', { checkOut: `${TUE}T18:45` })).change).toEqual({ checkOutAt: at(TUE, '18:45') });
  });

  it('late entry explanation: the day stays late, and is excused', () => {
    const tuesday = state(TUE, punches(TUE, '09:26', '18:30'));
    const { change } = check(tuesday, ask('late_explanation'));
    expect(change).toEqual({ lateExcused: true });
    expect(previewCorrection(tuesday, change!, context(), NOON)).toMatchObject({ status: 'present', lateMinutes: 26, flags: ['late', 'late_excused'], checkInAt: at(TUE, '09:26') });
  });

  it('half-day and absent corrections: the status is set by hand and the punches stay', () => {
    const wednesday = state(WED, punches(WED, '09:00', '14:00'));
    const full = check(wednesday, ask('half_day_correction', { status: 'present' }));
    expect(full.change).toEqual({ override: 'present' });
    expect(previewCorrection(wednesday, full.change!, context(), NOON)).toMatchObject({ status: 'present', checkOutAt: at(WED, '14:00'), workedMinutes: 300, units: { worked: 1 } });
    expect(previewCorrection(wednesday, full.change!, context(), NOON).flags).toContain('corrected');
    // A half-day cannot be "corrected" to a half-day.
    expect(check(wednesday, ask('half_day_correction', { status: 'half_day' })).errors).toEqual({ status: 'Choose what the day should count as.' });

    const monday = state(MON, null);
    const half = check(monday, ask('absent_correction', { status: 'half_day' }));
    expect(half.change).toEqual({ override: 'half_day' });
    expect(previewCorrection(monday, half.change!, context(), NOON)).toMatchObject({ status: 'half_day', flags: ['corrected'], checkInAt: null });
    expect(check(monday, ask('absent_correction')).errors).toEqual({ status: 'Choose what the day should count as.' });
  });

  it('missing check-in: only while the day can still be checked out afterwards', () => {
    // Today, at work since nine, never checked in.
    expect(check(state(THU, null), ask('missing_check_in', { checkIn: `${THU}T09:00` })).change).toEqual({ checkInAt: at(THU, '09:00') });
    // Monday is over: a check-in alone would leave the check-out missing.
    expect(check(state(MON, null), ask('missing_check_in', { checkIn: `${MON}T09:00` })).errors).toEqual({ checkIn: 'That day can no longer be checked out, so its check-out is missing too. Choose “Forgot to check in and out” and give both times.' });
  });

  it('needs a reason, and the times it asks for', () => {
    const monday = state(MON, null);
    expect(check(monday, ask('forgot_attendance', { reason: ' ' })).errors).toEqual({ reason: 'Say why, in a few words.', checkIn: 'Give the check-in time.', checkOut: 'Give the check-out time.' });
    expect(check(monday, ask('forgot_attendance', { checkIn: 'yesterday at nine', checkOut: `${MON}T18:00` })).errors).toEqual({ checkIn: 'Give the check-in time.' });
    expect(check(monday, ask('forgot_attendance', { checkIn: `${MON}T09:00`, checkOut: `${MON}T18:00`, reason: 'x'.repeat(501) })).errors).toEqual({ reason: 'Keep this to 500 characters or fewer.' });
  });

  it('keeps the times inside the bounds a real punch has', () => {
    const monday = state(MON, null);
    const both = (checkIn: string, checkOut: string) => check(monday, ask('forgot_attendance', { checkIn, checkOut })).errors;
    // Check-in opens at 06:00 and the day can be joined until 01:00 the next morning.
    expect(both(`${MON}T05:30`, `${MON}T18:00`)).toEqual({ checkIn: 'A check-in for Monday 7 December falls between 06:00 and 01:00 on Tuesday 8 December.' });
    expect(both(`${TUE}T09:00`, `${TUE}T18:00`).checkIn).toMatch(/falls between/);
    expect(both(`${MON}T06:00`, `${MON}T15:00`)).toEqual({});
    expect(both(`${MON}T09:00`, `${MON}T09:00`)).toEqual({ checkOut: 'The check-out has to be after the check-in.' });
    expect(both(`${MON}T09:00`, `${MON}T08:00`)).toEqual({ checkOut: 'The check-out has to be after the check-in.' });
    // Sixteen hours after a 09:00 check-in is 01:00.
    expect(both(`${MON}T09:00`, `${TUE}T01:00`)).toEqual({});
    expect(both(`${MON}T09:00`, `${TUE}T01:01`)).toEqual({ checkOut: 'With a check-in at 09:00, the day could be checked out until 01:00 on Tuesday 8 December at the latest: 16 h after check-in, and not after the next working day opens.' });
  });

  it('refuses a time that has not come yet', () => {
    // Thursday, noon. Nothing punched today.
    const today = state(THU, null);
    expect(check(today, ask('forgot_attendance', { checkIn: `${THU}T09:00`, checkOut: `${THU}T13:00` })).errors).toEqual({ checkOut: 'That time has not come yet.' });
    expect(check(today, ask('forgot_attendance', { checkIn: `${THU}T12:30`, checkOut: `${THU}T13:00` })).errors.checkIn).toBe('That time has not come yet.');
    expect(check(today, ask('forgot_attendance', { checkIn: `${THU}T09:00`, checkOut: `${THU}T12:00` })).errors).toEqual({});
  });

  it('puts the message on the time being changed', () => {
    const tuesday = state(TUE, punches(TUE, '09:26', '18:30'));
    expect(check(tuesday, ask('incorrect_check_in', { checkIn: `${TUE}T19:00` })).errors).toEqual({ checkIn: 'The check-in has to be before the check-out at 18:30.' });
    expect(check(tuesday, ask('incorrect_check_out', { checkOut: `${TUE}T09:00` })).errors).toEqual({ checkOut: 'The check-out has to be after the check-in.' });
    expect(check(state(MON, punches(MON, '17:30')), ask('missing_check_out', { checkOut: `${MON}T17:00` })).errors).toEqual({ checkOut: 'The check-out has to be after the check-in.' });
  });

  it('refuses an "incorrect" time that is the one already recorded', () => {
    const tuesday = state(TUE, punches(TUE, '09:26:40', '18:30:10'));
    expect(check(tuesday, ask('incorrect_check_in', { checkIn: `${TUE}T09:26` })).errors).toEqual({ checkIn: 'That is the check-in already recorded. Give the time it should be.' });
    expect(check(tuesday, ask('incorrect_check_out', { checkOut: `${TUE}T18:30` })).errors).toEqual({ checkOut: 'That is the check-out already recorded. Give the time it should be.' });
    expect(check(tuesday, ask('incorrect_check_in', { checkIn: `${TUE}T09:25` })).errors).toEqual({});
  });

  it('refuses a kind that does not fit the day as it is now', () => {
    expect(check(state(MON, null), ask('incorrect_check_out', { checkOut: `${MON}T18:00` }))).toEqual({ errors: { type: 'That kind of correction does not fit this day as it is now.' }, change: null });
    expect(check(state(TUE, punches(TUE, '09:00', '18:00')), ask('late_explanation')).errors.type).toBeDefined();
    expect(check(state(THU, punches(THU, '09:00')), ask('missing_check_out', { checkOut: `${THU}T11:00` })).errors.type).toBeDefined();
  });
});

describe('a correction made directly by HR', () => {
  const direct = (more: Partial<DirectCorrectionInput> = {}): Omit<DirectCorrectionInput, 'dayVersion'> => ({ checkIn: null, checkOut: null, override: null, lateExcused: false, reason: 'Confirmed with the client', ...more });
  const check = (dayState: DayState, input: Omit<DirectCorrectionInput, 'dayVersion'>, now = NOON) => validateDirectCorrection(input, dayState, context(dayState.rules), now);

  it('sets the facts as they should be, and names only what really changes', () => {
    expect(check(state(MON, null), direct({ checkIn: `${MON}T09:00`, checkOut: `${MON}T18:00` })).change).toEqual({ checkInAt: at(MON, '09:00'), checkOutAt: at(MON, '18:00') });

    // The check-in is left as it is on screen (09:26), so its recorded seconds are not touched.
    const tuesday = state(TUE, punches(TUE, '09:26:40', '18:30:05'));
    expect(check(tuesday, direct({ checkIn: `${TUE}T09:26`, checkOut: `${TUE}T18:45` })).change).toEqual({ checkOutAt: at(TUE, '18:45') });
    expect(check(tuesday, direct({ checkIn: `${TUE}T09:26`, checkOut: `${TUE}T18:30`, override: 'half_day' })).change).toEqual({ override: 'half_day' });
    expect(check(tuesday, direct({ checkIn: `${TUE}T09:26`, checkOut: `${TUE}T18:30`, lateExcused: true })).change).toEqual({ lateExcused: true });
  });

  it('can take a mistaken punch away, and the day goes back to what is left', () => {
    const tuesday = state(TUE, punches(TUE, '09:26', '18:30'));
    const { change } = check(tuesday, direct());
    expect(change).toEqual({ checkInAt: null, checkOutAt: null });
    expect(previewCorrection(tuesday, change!, context(), NOON)).toMatchObject({ status: 'absent', checkInAt: null });
    // Not half of it: a check-out with no check-in is not a day.
    expect(check(tuesday, direct({ checkOut: `${TUE}T18:30` })).errors).toEqual({ checkOut: 'A check-out needs a check-in to go with it.' });
  });

  it('refuses what changes nothing, what is in the future, and what does not apply', () => {
    expect(check(state(MON, null), direct()).errors).toEqual({ day: 'Nothing would change: the day already reads like this.' });
    expect(check(state('2026-12-11', null), direct({ override: 'present' })).errors).toEqual({ day: 'A day that has not come yet has nothing to correct.' });
    expect(check(state('2026-11-20', null), direct({ override: 'present' })).errors.day).toMatch(/not counted/);
    expect(check(state(MON, null), direct({ override: 'present', reason: '' })).errors).toEqual({ reason: 'Say why, in a few words.' });
  });

  it('sets a status by hand only on a working day, and excuses only a late entry', () => {
    expect(check(state(SUN, null, at('2026-12-15', '12:00')), direct({ override: 'present' }), at('2026-12-15', '12:00')).errors).toEqual({ override: 'A day off is not counted as present or half-day. Leave this as the hours say.' });
    expect(check(state(TUE, punches(TUE, '09:00', '18:00')), direct({ checkIn: `${TUE}T09:00`, checkOut: `${TUE}T18:00`, lateExcused: true })).errors).toEqual({ lateExcused: 'The day is not a late entry, so there is nothing to excuse.' });
    expect(check(state(MON, null), direct({ override: 'present' })).change).toEqual({ override: 'present' });
  });

  it('holds the times to the same bounds as a request', () => {
    expect(check(state(MON, null), direct({ checkIn: `${MON}T05:00`, checkOut: `${MON}T18:00` })).errors.checkIn).toMatch(/falls between 06:00/);
    expect(check(state(MON, null), direct({ checkIn: `${MON}T10:00`, checkOut: `${MON}T09:00` })).errors).toEqual({ checkOut: 'The check-out has to be after the check-in.' });
    expect(check(state(MON, null), direct({ checkIn: 'soon' })).errors).toEqual({ checkIn: 'Give the check-in time, or leave it empty.' });
  });
});

describe('a change laid over a day', () => {
  it('touches only the facts it names', () => {
    const before = punches(TUE, '09:26', '18:30', { breaks: [{ startAt: at(TUE, '13:00'), endAt: at(TUE, '13:30') }] });
    expect(applyChange(before, { checkOutAt: at(TUE, '18:45') })).toEqual({ ...before, checkOutAt: at(TUE, '18:45'), corrected: true });
    // Only a change of times marks the day's times as corrected.
    expect(applyChange(before, { lateExcused: true })).toEqual({ ...before, lateExcused: true, corrected: false });
    expect(applyChange(null, { override: 'present' })).toEqual({ checkInAt: null, checkOutAt: null, breaks: [], override: 'present', lateExcused: false, corrected: false });
  });

  it('is one of three kinds in the day’s history', () => {
    expect(changeKind({ checkInAt: at(TUE, '09:00') })).toBe('corrected');
    expect(changeKind({ checkOutAt: null, override: 'present' })).toBe('corrected');
    expect(changeKind({ override: 'present' })).toBe('overridden');
    expect(changeKind({ lateExcused: true })).toBe('excused');
  });

  it('reads in words', () => {
    expect(changeInWords({ checkInAt: at(MON, '09:05'), checkOutAt: at(TUE, '00:40') }, MON, ZONE)).toEqual(['Check-in 09:05', 'Check-out 00:40 on Tuesday 8 December']);
    expect(changeInWords({ checkInAt: null, checkOutAt: null }, MON, ZONE)).toEqual(['Check-in removed', 'Check-out removed']);
    expect(changeInWords({ override: 'half_day' }, MON, ZONE)).toEqual(['Counts as a half-day']);
    expect(changeInWords({ override: null, lateExcused: true }, MON, ZONE)).toEqual(['Counts as the hours say', 'Late entry excused']);
  });
});

describe('who may decide a request', () => {
  const person = (id: string, role: OrgNode['role'], managerId: string | null = null): OrgNode => ({ id, role, managerId, status: 'active' });
  const admin = person('admin', 'Admin');
  const hr = person('hr', 'HR');
  const manager = person('manager', 'Manager');
  const lead = person('lead', 'Manager', 'manager');
  const employee = person('employee', 'Employee', 'lead');
  const outsider = person('outsider', 'Employee');
  // An HR account that someone has made report to a manager.
  const hrUnderManager = person('hr2', 'HR', 'manager');
  const everyone = [admin, hr, manager, lead, employee, outsider, hrUnderManager];
  const verdict = (approver: OrgNode, requester: OrgNode) => approvalVerdict(approver, requester.id, everyone);

  it('is never the person who made it', () => {
    for (const who of everyone) expect(verdict(who, who)).toBe('own');
  });

  it('is their manager, directly or further up, and HR and Admin', () => {
    expect(verdict(lead, employee)).toBe('allowed');
    expect(verdict(manager, employee)).toBe('allowed');
    expect(verdict(manager, lead)).toBe('allowed');
    expect(verdict(hr, employee)).toBe('allowed');
    expect(verdict(admin, employee)).toBe('allowed');
  });

  it('is not a manager outside their chain, nor a colleague', () => {
    expect(verdict(manager, outsider)).toBe('not_theirs');
    expect(verdict(lead, manager)).toBe('not_theirs');
    expect(verdict(outsider, employee)).toBe('not_theirs');
    expect(verdict(employee, lead)).toBe('not_theirs');
    expect(approvalVerdict(manager, 'nobody', everyone)).toBe('not_theirs');
  });

  it('is never through a manager for a request from HR or an Admin: another HR or Admin decides', () => {
    expect(verdict(manager, hrUnderManager)).toBe('not_theirs');
    expect(verdict(hr, hrUnderManager)).toBe('allowed');
    expect(verdict(admin, hr)).toBe('allowed');
    expect(verdict(hr, admin)).toBe('allowed');
  });

  it('lists everyone whose requests a person decides', () => {
    expect(decidableBy(manager, everyone)).toEqual(['lead', 'employee']);
    expect(decidableBy(lead, everyone)).toEqual(['employee']);
    expect(decidableBy(employee, everyone)).toEqual([]);
    expect(decidableBy(hr, everyone)).toEqual(['admin', 'manager', 'lead', 'employee', 'outsider', 'hr2']);
  });
});
