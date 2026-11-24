/*
 * End-to-end tests of leave (Phase 7) against a real MongoDB. The clock is set by the tests
 * and only moves forward through the file: a Monday of setting up, asking and deciding, a
 * fortnight of leave being taken, and the turn of the leave year.
 *
 * What a request uses and when it may be sent is tested exhaustively in shared. Here it is
 * what the API must hold however requests arrive: the days of a request held exactly once, a
 * balance never overdrawn by two requests at the same instant, a decision made once, a chain
 * stopped half way finished afterwards, nobody deciding or adjusting what is not theirs, and
 * approved leave always reading as leave.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  CONFIRM_PAST,
  exampleA,
  OWN_RECORD_MESSAGE,
  startingEntry,
  zonedToInstant,
  type AssignmentResult,
  type AttendanceCalendarPayload,
  type CompanySettings,
  type ErrorPayload,
  type Holiday,
  type HolidayCalendar,
  type HolidayEffect,
  type LeaveBalancesPayload,
  type LeaveInboxItem,
  type LeaveListPayload,
  type LeavePart,
  type LeavePolicy,
  type LeavePreviewPayload,
  type LeaveRequest,
  type LeaveRow,
  type LeaveSetupPayload,
  type LeaveType,
  type MePayload,
  type MyDashboardPayload,
  type PeriodSummary,
  type PolicyEntry,
  type TemporaryPasswordPayload,
  type TodayPayload,
} from '@delta-hrms/shared';
import { boot, Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

const ZONE = 'Asia/Kolkata';
/** Monday 7 December 2026. `D(n)` is n days later: D(1) Tuesday 8, D(6) Sunday 13, D(7) Monday 14. */
const MON = '2026-12-07';
const D = (n: number) => addDays(MON, n);

const moment = (date: string, time: string) => zonedToInstant(date, time, ZONE).toISOString();
const setNow = (date: string, time: string) => mod.clock.setTestNow(moment(date, time));

beforeAll(async () => {
  await boot('leave');
  if (!reachable) return;
  setNow(MON, '05:00');
  await resetToSample();
  // Everyone has been here since mid-2024, except two people who joined during this leave year.
  await mod.db().employees.updateMany({}, { $set: { joinDate: '2024-06-01' } });
  await mod.db().employees.updateOne({ email: emailByKey('sneha') }, { $set: { joinDate: '2026-07-15' } });
  await mod.db().employees.updateOne({ email: emailByKey('joseph') }, { $set: { joinDate: '2026-11-01' } });
});
afterAll(shutdown);

const emailByKey = (key: string) => mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.email;
const idByKey = (key: string) => idOf(emailByKey(key));
const clients = new Map<string, Client>();
async function person(key: string) {
  let client = clients.get(key);
  if (!client) {
    client = await signIn(emailByKey(key));
    clients.set(key, client);
  }
  return client;
}

/** The ids of what the tests make: kinds of leave by code, policies and holidays by name. */
const made = new Map<string, string>();
const typeId = (code: string) => made.get(code)!;

const TYPES = [
  { name: 'Casual leave', code: 'CL', paid: true, allowHalfDay: true, tone: 'blue' },
  { name: 'Earned leave', code: 'EL', paid: true, allowHalfDay: false, tone: 'green' },
  { name: 'Sick leave', code: 'SL', paid: true, allowHalfDay: true, tone: 'amber' },
  { name: 'Unpaid leave', code: 'LOP', paid: false, allowHalfDay: true, tone: 'slate' },
] as const;
const RULES: Record<string, Partial<PolicyEntry>> = {
  CL: { annualDays: 12, maxConsecutiveDays: 3 },
  EL: { annualDays: 15, carryForwardMax: 10, minNoticeDays: 7, eligibleAfterDays: 90 },
  SL: { annualDays: 8, backdateDays: 7 },
  LOP: { annualDays: 0, backdateDays: 7 },
};
const standardEntries = (more: Record<string, Partial<PolicyEntry>> = {}) => TYPES.map((t) => ({ ...startingEntry(typeId(t.code)), ...RULES[t.code], ...more[t.code] }));

const accountOf = async (viewer: string, key = viewer, year?: number) => (await person(viewer)).get<LeaveBalancesPayload & ErrorPayload>(`/leave/balances?employeeId=${await idByKey(key)}${year ? `&year=${year}` : ''}`);
/** One kind of leave in someone's account, as HR or the Admin sees it. */
async function balance(key: string, code: string, year?: number) {
  const answer = await accountOf(key === 'admin' ? 'hr' : 'admin', key, year);
  expect(answer.status, answer.body?.error ?? '').toBe(200);
  return answer.body.rows.find((row) => row.type.code === code)!.balance;
}
const storedAccount = async (key: string, year = 2026) => mod.db().leaveAccounts.findOne({ _id: `${await idByKey(key)}|${year}` });
const storedRequest = (id: string) => mod.db().leaveRequests.findOne({ _id: id });
const auditOf = (action: string) => mod.db().audit.find({ action }).sort({ $natural: 1 }).toArray();

type Ask = { dayPart?: LeavePart; reason?: string };
const ask = (key: string, code: string, startDate: string, endDate = startDate, more: Ask = {}) =>
  person(key).then((client) => client.post<LeaveRequest & ErrorPayload>('/leave/requests', { leaveTypeId: typeId(code), startDate, endDate, dayPart: 'full', reason: 'A family function', ...more }));
/** Sends a request that must be accepted, and returns it. */
async function asked(key: string, code: string, startDate: string, endDate = startDate, more: Ask = {}) {
  const answer = await ask(key, code, startDate, endDate, more);
  expect(answer.status, `${key} ${code} ${startDate}: ${answer.body?.error ?? ''}`).toBe(201);
  return answer.body;
}
const preview = async (key: string, code: string, startDate: string, endDate = startDate, dayPart: LeavePart = 'full') =>
  (await (await person(key)).post<LeavePreviewPayload>('/leave/requests/preview', { leaveTypeId: typeId(code), startDate, endDate, dayPart })).body;
const decide = async (key: string, id: string, action: 'approve' | 'reject', note = '') => (await person(key)).post<LeaveRequest & ErrorPayload>(`/leave/requests/${id}/${action}`, { note });
async function approved(key: string, request: LeaveRequest) {
  const answer = await decide(key, request.id, 'approve');
  expect(answer.status, answer.body?.error ?? '').toBe(200);
  return answer.body;
}
const cancel = async (key: string, id: string, reason?: string) => (await person(key)).post<LeaveRequest & ErrorPayload>(`/leave/requests/${id}/cancel`, reason === undefined ? {} : { reason });
const listOf = async (key: string, query = '') => (await person(key)).get<LeaveListPayload & ErrorPayload>(`/leave/requests${query}`);
const inboxOf = async (key: string) => (await listOf(key, '?view=inbox')).body.items as LeaveInboxItem[];
const waitingFor = async (key: string) => (await (await person(key)).get<MePayload>('/me')).body.approvalsWaiting;
const monthOf = async (key: string, month = '2026-12') => (await (await person('admin')).get<AttendanceCalendarPayload>(`/attendance/calendar?employeeId=${await idByKey(key)}&month=${month}`)).body;
const accountedFor = (s: PeriodSummary) => s.presentDays + s.halfDays / 2 + s.leaveDays + s.absentDays + s.unresolvedDays;
const punch = async (key: string, action: 'check-in' | 'check-out') => {
  const answer = await (await person(key)).post<TodayPayload & ErrorPayload>(`/attendance/${action}`);
  expect(answer.status, `${key} ${action}: ${answer.body?.error ?? ''}`).toBe(200);
  return answer.body;
};
const adjust = async (key: string, target: string, code: string, days: number, note = 'Compensation for the stock-taking weekend', leaveYear = 2026) =>
  (await person(key)).post<LeaveBalancesPayload & ErrorPayload>('/leave/adjustments', { employeeId: await idByKey(target), leaveYear, leaveTypeId: typeId(code), days, note });

/** Requests the later tests come back to. */
const kept: Record<string, LeaveRequest> = {};

describe.skipIf(!reachable)('leave', () => {
  describe('setting it up', () => {
    it('lets only HR and Admin set leave up; everyone may read the kinds of leave', async () => {
      setNow(MON, '08:00');
      for (const key of ['employee', 'manager']) {
        const client = await person(key);
        expect((await client.post('/leave-types', TYPES[0])).status, key).toBe(403);
        expect((await client.patch('/leave-types/lvt_000000000000', { ...TYPES[0], archived: true })).status, key).toBe(403);
        expect((await client.get('/leave-policies')).status, key).toBe(403);
        expect((await client.post('/leave-policies', { name: 'Mine', approver: 'manager', entries: [] })).status, key).toBe(403);
        expect((await client.post('/leave-policies/assign', { policyId: null, employeeIds: [await idByKey(key)] })).status, key).toBe(403);
        expect((await client.post('/leave/adjustments', { employeeId: await idByKey(key), leaveYear: 2026, leaveTypeId: 'lvt_000000000000', days: 5, note: 'A few more days' })).status, key).toBe(403);
        expect((await client.get<LeaveType[]>('/leave-types')).status, key).toBe(200);
      }
    });

    it('adds kinds of leave, each with a code and a name of its own', async () => {
      const hr = await person('hr');
      for (const type of TYPES) {
        const created = await hr.post<LeaveType>('/leave-types', { ...type, code: type.code.toLowerCase(), name: `  ${type.name} ` });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ ...type, archived: false });
        made.set(type.code, created.body.id);
      }
      const sameCode = await hr.post<ErrorPayload>('/leave-types', { ...TYPES[0], name: 'Compensatory off' });
      expect([sameCode.status, sameCode.body.fields]).toEqual([422, { code: 'Another kind of leave already has that code.' }]);
      const sameName = await hr.post<ErrorPayload>('/leave-types', { ...TYPES[0], code: 'CAS', name: 'casual  LEAVE' });
      expect([sameName.status, sameName.body.fields]).toEqual([422, { name: 'Another kind of leave already has that name.' }]);
      expect((await hr.post<ErrorPayload>('/leave-types', { ...TYPES[0], code: 'x', name: ' ' })).body.fields).toHaveProperty('code');
      // A field the route does not know is refused, not ignored.
      expect((await hr.post('/leave-types', { ...TYPES[0], code: 'CO', name: 'Compensatory off', archived: true })).status).toBe(400);

      expect((await (await person('employee')).get<LeaveType[]>('/leave-types')).body.map((t) => t.code)).toEqual(['CL', 'EL', 'SL', 'LOP']);
      expect((await auditOf('leave_type.created')).map((row) => row.actor?.name)).toEqual(['Rahul Nair', 'Rahul Nair', 'Rahul Nair', 'Rahul Nair']);
    });

    it('adds policies, checked entry by entry, and puts new people on the first one', async () => {
      const hr = await person('hr');
      const standard = await hr.post<LeavePolicy>('/leave-policies', { name: 'Standard', approver: 'manager', entries: standardEntries() });
      expect(standard.status).toBe(201);
      made.set('Standard', standard.body.id);
      const hrOnly = await hr.post<LeavePolicy>('/leave-policies', { name: 'HR decides', approver: 'hr', entries: [{ ...startingEntry(typeId('CL')), annualDays: 6 }] });
      made.set('HR decides', hrOnly.body.id);

      expect((await hr.post<ErrorPayload>('/leave-policies', { name: 'standard ', approver: 'manager', entries: standardEntries() })).body.fields).toEqual({ name: 'Another leave policy already has that name.' });
      expect((await hr.post<ErrorPayload>('/leave-policies', { name: 'Empty', approver: 'manager', entries: [] })).body.fields).toHaveProperty('entries');
      const bad = await hr.post<ErrorPayload>('/leave-policies', { name: 'Bad', approver: 'manager', entries: [{ ...startingEntry(typeId('CL')), annualDays: 12.25 }, { ...startingEntry('lvt_000000000000') }] });
      expect([bad.status, new Set(Object.keys(bad.body.fields ?? {}))]).toEqual([422, new Set([`entries.${typeId('CL')}.annualDays`, 'entries.lvt_000000000000.leaveTypeId'])]);

      const setup = (await hr.get<LeaveSetupPayload>('/leave-policies')).body;
      expect(setup.policies.map((p) => [p.name, p.approver, p.isDefault, p.peopleCount])).toEqual([
        ['HR decides', 'hr', false, 0],
        ['Standard', 'manager', true, 0],
      ]);
      // Twelve people are not deactivated, and nobody is on a policy yet.
      expect(setup).toMatchObject({ withoutPolicy: 12, yearLabel: '2026' });
      expect(setup.types).toHaveLength(4);
    });

    it('puts people on a policy one by one, opens their account, and never moves HR by their own hand', async () => {
      const hr = await person('hr');
      const keys = ['employee', 'manager', 'lead', 'divya', 'imran', 'sneha', 'joseph', 'admin', 'hr', 'leela'];
      const given = await hr.post<AssignmentResult>('/leave-policies/assign', { policyId: made.get('Standard'), employeeIds: [...(await Promise.all(keys.map(idByKey))), 'emp_000000000000'] });
      expect(given.body.assigned.map((a) => a.name)).toEqual(['Arjun Das', 'Fatima Khan', 'Vivek Sharma', 'Divya Thomas', 'Imran Sheikh', 'Sneha Iyer', 'Joseph Mathew', 'Anita Menon']);
      expect(given.body.skipped).toEqual([
        { employeeId: await idByKey('hr'), name: 'Rahul Nair', reason: OWN_RECORD_MESSAGE },
        { employeeId: await idByKey('leela'), name: 'Leela George', reason: 'They are deactivated. Reactivate them first.' },
        { employeeId: 'emp_000000000000', name: '', reason: 'That person no longer exists.' },
      ]);
      // Another HR or Admin does it for them.
      const forHr = await (await person('admin')).post<AssignmentResult>('/leave-policies/assign', { policyId: made.get('Standard'), employeeIds: [await idByKey('hr')] });
      expect(forHr.body.assigned).toHaveLength(1);
      expect((await hr.post<AssignmentResult>('/leave-policies/assign', { policyId: made.get('Standard'), employeeIds: [await idByKey('employee')] })).body.skipped[0]?.reason).toBe('They are already on the leave policy "Standard".');

      // The account of this leave year exists from that moment, with the year's allowance in it.
      const account = (await storedAccount('employee'))!;
      expect(account).toMatchObject({ leaveYear: 2026, bookings: [], carried: true, version: 1 });
      expect(account.entries.map((e) => [e.kind, e.days, e.by, e.note])).toEqual([
        ['grant', 12, null, 'Allowance for 2026'],
        ['grant', 15, null, 'Allowance for 2026'],
        ['grant', 8, null, 'Allowance for 2026'],
      ]);
      expect((await auditOf('leave_policy.assigned')).length).toBe(9);
      expect((await hr.get<LeaveSetupPayload>('/leave-policies')).body).toMatchObject({ withoutPolicy: 3 });
    });

    it('pro-rates the first year of someone who joined during it', async () => {
      // Sneha joined on 15 July: July to December is six months of twelve.
      expect([(await balance('sneha', 'CL')).granted, (await balance('sneha', 'EL')).granted, (await balance('sneha', 'SL')).granted]).toEqual([6, 7.5, 4]);
      expect((await storedAccount('sneha'))!.entries[0]).toMatchObject({ note: 'Allowance for 2026, pro-rated from 15 Jul 2026' });
      // Joseph joined in November: two months.
      expect([(await balance('joseph', 'CL')).granted, (await balance('joseph', 'EL')).granted, (await balance('joseph', 'SL')).granted]).toEqual([2, 2.5, 1]);
    });

    it('makes the year’s grant once: a policy edited afterwards changes what is granted from then on', async () => {
      const hr = await person('hr');
      const generous = await hr.patch<LeavePolicy>(`/leave-policies/${made.get('Standard')}`, { name: 'Standard', approver: 'manager', entries: standardEntries({ CL: { annualDays: 14 } }) });
      expect(generous.status).toBe(200);
      // Arjun was granted 12 and keeps 12. Kiran is put on the policy now and is granted 14.
      expect((await balance('employee', 'CL')).granted).toBe(12);
      await hr.post('/leave-policies/assign', { policyId: made.get('Standard'), employeeIds: [await idByKey('kiran')] });
      expect((await balance('kiran', 'CL')).granted).toBe(14);
      await hr.patch(`/leave-policies/${made.get('Standard')}`, { name: 'Standard', approver: 'manager', entries: standardEntries() });
      expect((await balance('kiran', 'CL')).granted).toBe(14);
      expect((await storedAccount('employee'))!.version).toBe(1);
      expect((await auditOf('leave_policy.updated')).at(-1)?.summary).toMatch(/allowances already granted stay as they are/);
    });

    it('shows a person their own account, and anyone else’s only to those who may see them', async () => {
      const mine = (await accountOf('employee')).body;
      expect(mine).toMatchObject({ leaveYear: 2026, yearLabel: '2026', currentYear: 2026, today: MON, range: { from: '2026-01-01', to: '2026-12-31' }, policy: { name: 'Standard', approver: 'manager' }, canAdjust: false });
      expect(mine.years.map((y) => y.year)).toEqual([2026, 2027]);
      expect(mine.rows.map((row) => [row.type.code, row.balance.granted, row.balance.available, row.entry?.maxConsecutiveDays ?? null])).toEqual([
        ['CL', 12, 12, 3],
        ['EL', 15, 15, null],
        ['SL', 8, 8, null],
        ['LOP', 0, 0, null],
      ]);
      expect(mine.entries.map((e) => e.typeName)).toEqual(['Casual leave', 'Earned leave', 'Sick leave']);

      // Divya is not Arjun, and Vivek is not his manager: for them he does not exist. Fatima is, and HR sees everyone.
      expect((await accountOf('divya', 'employee')).status).toBe(404);
      expect((await accountOf('lead', 'employee')).status).toBe(404);
      expect((await accountOf('manager', 'employee')).body).toMatchObject({ employee: { name: 'Arjun Das' }, canAdjust: false });
      expect((await accountOf('hr', 'employee')).body.canAdjust).toBe(true);
      // HR may not adjust their own account; another HR or Admin may.
      expect((await accountOf('hr')).body.canAdjust).toBe(false);
      expect((await accountOf('admin', 'hr')).body.canAdjust).toBe(true);
      expect((await accountOf('employee', 'employee', 2031)).status).toBe(404);
    });
  });

  describe('asking for leave', () => {
    it('gives two people a holiday calendar, with a holiday in ten days', async () => {
      const hr = await person('hr');
      const calendar = await hr.post<HolidayCalendar>('/holiday-calendars', { name: 'India' });
      made.set('India', calendar.body.id);
      const given = await hr.post<AssignmentResult>('/holiday-calendars/assign', { calendarId: calendar.body.id, employeeIds: [await idByKey('employee'), await idByKey('joseph')], effectiveFrom: D(1) });
      expect(given.body.assigned).toHaveLength(2);
      const holiday = await hr.post<Holiday>('/holidays', { calendarId: calendar.body.id, date: D(10), name: 'Founders’ Day', type: 'company', description: '' });
      expect(holiday.status).toBe(201);
      made.set('Founders’ Day', holiday.body.id);
    });

    it('counts the days by the person’s own schedule and holidays, before anything is sent', async () => {
      // Arjun has Sunday off: Friday to Monday is three days.
      expect(await preview('employee', 'CL', D(4), D(7))).toEqual({ errors: {}, yearLabel: '2026', days: 3, charged: [D(4), D(5), D(7)], notCounted: [{ date: D(6), why: 'weekly_off' }], balance: { available: 12, after: 9, unlimited: false } });
      // Divya has Friday off: the same dates are three other days.
      expect(await preview('divya', 'CL', D(4), D(7))).toMatchObject({ days: 3, charged: [D(5), D(6), D(7)], notCounted: [{ date: D(4), why: 'weekly_off' }] });
      // The holiday on Arjun's calendar costs nothing. Divya is on no calendar: for her it is a working day.
      expect(await preview('employee', 'SL', D(9), D(11))).toMatchObject({ errors: {}, days: 2, charged: [D(9), D(11)], notCounted: [{ date: D(10), why: 'holiday', name: 'Founders’ Day' }] });
      expect(await preview('divya', 'SL', D(9), D(10))).toMatchObject({ days: 2, notCounted: [] });
      expect(await preview('employee', 'SL', D(7), D(7), 'first_half')).toMatchObject({ days: 0.5, balance: { available: 8, after: 7.5 } });
      expect(await preview('employee', 'LOP', D(7), D(8))).toMatchObject({ errors: {}, balance: { available: 0, after: -2, unlimited: true } });
    });

    it('says what is wrong with a request, by field, with the rule that stands in its way', async () => {
      expect((await preview('employee', 'SL', D(7), D(8), 'first_half')).errors).toEqual({ dayPart: 'A half-day is for a single date. Choose one date, or the full days.' });
      expect((await preview('employee', 'EL', D(7), D(7), 'second_half')).errors).toEqual({ dayPart: 'Earned leave cannot be taken as a half-day.' });
      expect((await preview('employee', 'LOP', '2026-12-30', '2027-01-02')).errors.endDate).toMatch(/stays inside one leave year, and a new one starts on Friday 1 January/);
      expect((await preview('employee', 'CL', D(6))).errors.startDate).toMatch(/no working day for you/);
      expect((await preview('employee', 'EL', D(1))).errors.startDate).toBe('Earned leave has to be asked for 7 days ahead: it can start on Monday 14 December at the earliest.');
      // Joseph joined on 1 November and earned leave needs ninety days of service.
      expect((await preview('joseph', 'EL', D(7))).errors.startDate).toBe('You can take Earned leave from Saturday 30 January: 90 days after joining.');
      // Kiran has no schedule, so no day is a working day for him.
      expect((await preview('kiran', 'CL', D(1))).errors.startDate).toMatch(/no work schedule on those dates/);
      // Nisha is on no policy.
      expect((await preview('nisha', 'CL', D(1))).errors.leaveTypeId).toMatch(/not on a leave policy yet/);
      const client = await person('employee');
      expect((await client.post<LeavePreviewPayload>('/leave/requests/preview', { leaveTypeId: '', startDate: '', endDate: '', dayPart: 'full' })).body.errors).toMatchObject({ leaveTypeId: 'Choose a kind of leave.', startDate: 'Choose the first day.' });
      // A preview is the caller's own: it takes no employee, and it writes nothing.
      expect((await client.post('/leave/requests/preview', { employeeId: await idByKey('divya'), leaveTypeId: typeId('CL'), startDate: D(1), endDate: D(1), dayPart: 'full' })).status).toBe(400);
      expect(await mod.db().leaveRequests.countDocuments()).toBe(0);
      expect((await storedAccount('employee'))!.version).toBe(1);
    });

    it('holds the days of a request from the moment it is sent', async () => {
      setNow(MON, '09:00');
      kept.arjunCasual = await asked('employee', 'CL', D(1), D(2));
      expect(kept.arjunCasual).toMatchObject({ status: 'pending', settled: true, leaveYear: 2026, days: 2, charged: [D(1), D(2)], approver: 'manager', dayPart: 'full', decidedBy: null });
      expect(await balance('employee', 'CL')).toMatchObject({ granted: 12, taken: 0, held: 2, balance: 12, available: 10 });
      expect((await storedAccount('employee'))!.bookings).toEqual([{ requestId: kept.arjunCasual.id, leaveTypeId: typeId('CL'), startDate: D(1), endDate: D(2), dayPart: 'full', days: 2, state: 'held' }]);
      expect((await auditOf('leave.requested')).at(-1)).toMatchObject({ employeeId: await idByKey('employee'), summary: 'Arjun Das asked for 2 days of Casual leave: Tuesday 8 December to Wednesday 9 December.' });
      // It waits for his manager, and for HR and the Admin, who can always act. Not for him, and not for another team's lead.
      expect(await Promise.all(['manager', 'hr', 'admin', 'lead', 'employee'].map(waitingFor))).toEqual([1, 1, 1, 0, 0]);
      // A reason is asked for, and a request is always the caller's own.
      expect((await ask('employee', 'SL', D(7), D(7), { reason: 'x' })).body.fields).toEqual({ reason: 'Say why, in a few words.' });
      const client = await person('employee');
      expect((await client.post('/leave/requests', { employeeId: await idByKey('divya'), leaveTypeId: typeId('CL'), startDate: D(7), endDate: D(7), dayPart: 'full', reason: 'For Divya' })).status).toBe(400);
    });

    it('refuses dates that overlap leave already asked for, and lets two halves of one day stand side by side', async () => {
      const overlap = await ask('employee', 'CL', D(2));
      expect([overlap.status, overlap.body.fields]).toEqual([422, { startDate: 'You already have leave waiting for approval for Tuesday 8 December to Wednesday 9 December.' }]);
      expect((await ask('employee', 'SL', D(1), D(1), { dayPart: 'first_half' })).status).toBe(422);
      expect((await ask('employee', 'LOP', D(0), D(1))).status).toBe(422);

      kept.arjunMorning = await asked('employee', 'SL', D(4), D(4), { dayPart: 'first_half' });
      kept.arjunAfternoon = await asked('employee', 'CL', D(4), D(4), { dayPart: 'second_half' });
      expect([kept.arjunMorning.days, kept.arjunAfternoon.days]).toEqual([0.5, 0.5]);
      expect((await ask('employee', 'SL', D(4), D(4), { dayPart: 'first_half' })).status).toBe(422);
      expect((await ask('employee', 'SL', D(4))).status).toBe(422);
      expect(await balance('employee', 'CL')).toMatchObject({ held: 2.5, available: 9.5 });
      expect(await balance('employee', 'SL')).toMatchObject({ held: 0.5, available: 7.5 });
    });

    it('holds a kind of leave to its longest run, also across two requests and a weekly off', async () => {
      // Divya works Saturday, Sunday and Monday: three days of casual leave, the most the policy allows in a row.
      kept.divyaCasual = await asked('divya', 'CL', D(5), D(7));
      expect(kept.divyaCasual.days).toBe(3);
      const after = await ask('divya', 'CL', D(8));
      expect(after.body.fields?.endDate).toBe('Casual leave can be taken for 3 days in a row at most, and with the Casual leave you already have next to these dates this would make 4 days.');
      // Thursday is next to it too: Friday in between is her weekly off.
      expect((await ask('divya', 'CL', D(3))).status).toBe(422);
      expect((await ask('divya', 'CL', D(8), D(11))).body.fields).toHaveProperty('endDate');
      // Leave of another kind is not part of the run.
      kept.divyaSick = await asked('divya', 'SL', D(3));
    });

    it('twenty identical requests at the same instant hold the days once', async () => {
      await person('imran');
      const answers = await Promise.all(Array.from({ length: 20 }, () => ask('imran', 'CL', D(1))));
      expect(answers.map((a) => a.status).sort()).toEqual([201, ...Array<number>(19).fill(422)]);
      const imran = await idByKey('imran');
      const requests = await mod.db().leaveRequests.find({ employeeId: imran }).toArray();
      expect(requests.map((r) => [r.status, r.settled, r.days])).toEqual([['pending', true, 1]]);
      const account = (await storedAccount('imran'))!;
      expect(account.bookings.map((b) => [b.requestId, b.days, b.state])).toEqual([[requests[0]!._id, 1, 'held']]);
      expect(account.version).toBe(2);
      expect(await balance('imran', 'CL')).toMatchObject({ held: 1, available: 11 });
      expect((await auditOf('leave.requested')).filter((row) => row.employeeId === imran)).toHaveLength(1);
    });

    it('two requests that together exceed the balance, sent together, pass one', async () => {
      // HR takes six days of sick leave off Imran's account: two are left.
      expect((await adjust('hr', 'imran', 'SL', -6, 'Taken before the HRMS was in use')).status).toBe(201);
      expect(await balance('imran', 'SL')).toMatchObject({ granted: 8, adjusted: -6, available: 2 });
      const answers = await Promise.all([ask('imran', 'SL', D(2), D(3)), ask('imran', 'SL', D(5), D(6))]);
      expect(answers.map((a) => a.status).sort()).toEqual([201, 422]);
      expect(answers.find((a) => a.status === 422)!.body.fields).toEqual({ leaveTypeId: 'This needs 2 days of Sick leave and you have 0 days available (2 days held by requests still waiting).' });
      expect(await balance('imran', 'SL')).toMatchObject({ held: 2, balance: 2, available: 0 });
      expect((await storedAccount('imran'))!.bookings).toHaveLength(2);
      // Days that a waiting request holds cannot be asked for a second time.
      expect((await ask('imran', 'SL', D(7))).body.fields?.leaveTypeId).toMatch(/you have 0 days available/);
      // Unpaid leave needs no balance. Nothing else may go below zero unless the policy says so.
      kept.imranUnpaid = await asked('imran', 'LOP', D(7));
      expect(await balance('imran', 'LOP')).toMatchObject({ granted: 0, held: 1, available: -1 });
      expect(await mod.db().leaveRequests.countDocuments({ status: 'submitting' })).toBe(0);
    });
  });

  describe('deciding', () => {
    it('shows each approver the requests that are theirs to decide, with what each does to the balance', async () => {
      setNow(MON, '10:00');
      const fatima = await inboxOf('manager');
      // Fatima's chain: Arjun, and through Vivek also Divya and Imran. (All were sent in the same test minute, so their order here says nothing.)
      const brief = (items: LeaveInboxItem[]) => items.map((item) => `${item.employeeName}, ${item.typeCode}, ${item.days}`).sort();
      expect(brief(fatima)).toEqual(['Arjun Das, CL, 0.5', 'Arjun Das, CL, 2', 'Arjun Das, SL, 0.5', 'Divya Thomas, CL, 3', 'Divya Thomas, SL, 1', 'Imran Sheikh, CL, 1', 'Imran Sheikh, LOP, 1', 'Imran Sheikh, SL, 2']);
      expect(fatima.find((item) => item.id === kept.arjunCasual!.id)).toMatchObject({ typeName: 'Casual leave', paid: true, cancel: 'no', unlimited: false, balance: { granted: 12, held: 2.5, balance: 12, available: 9.5 } });
      expect(fatima.find((item) => item.id === kept.imranUnpaid!.id)).toMatchObject({ typeName: 'Unpaid leave', paid: false, unlimited: true });
      // Vivek decides for Divya and Imran, not for Arjun. An employee decides nothing.
      expect(brief(await inboxOf('lead'))).toEqual(['Divya Thomas, CL, 3', 'Divya Thomas, SL, 1', 'Imran Sheikh, CL, 1', 'Imran Sheikh, LOP, 1', 'Imran Sheikh, SL, 2']);
      expect((await listOf('employee', '?view=inbox')).status).toBe(403);
      expect((await listOf('employee', '?view=decided')).status).toBe(403);
      expect(await Promise.all(['manager', 'lead', 'hr', 'employee'].map(waitingFor))).toEqual([8, 5, 8, 0]);
    });

    it('lets nobody decide their own request, or one that is not theirs', async () => {
      const id = kept.arjunCasual!.id;
      expect((await decide('employee', id, 'approve')).status).toBe(403);
      // For someone who has no say in it, the request does not exist.
      expect((await decide('divya', id, 'approve')).status).toBe(404);
      expect((await decide('lead', id, 'approve')).status).toBe(404);
      expect((await decide('lead', id, 'reject', 'No')).status).toBe(404);
      expect((await decide('manager', 'lvr_000000000000', 'approve')).status).toBe(404);
      expect((await storedRequest(id))!.status).toBe('pending');
    });

    it('approves once: the held days become taken, and a second decision is refused', async () => {
      const done = await decide('manager', kept.arjunCasual!.id, 'approve', 'Enjoy the days off');
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'approved', settled: true, decidedByName: 'Fatima Khan', decisionNote: 'Enjoy the days off' });
      expect((await storedAccount('employee'))!.bookings.find((b) => b.requestId === kept.arjunCasual!.id)).toMatchObject({ state: 'taken', days: 2 });
      expect(await balance('employee', 'CL')).toMatchObject({ taken: 2, held: 0.5, balance: 10, available: 9.5 });
      expect((await auditOf('leave.approved')).at(-1)).toMatchObject({ actor: { name: 'Fatima Khan' }, summary: 'Approved Arjun Das\'s 2 days of Casual leave (Tuesday 8 December to Wednesday 9 December).' });

      for (const key of ['manager', 'hr']) {
        const again = await decide(key, kept.arjunCasual!.id, key === 'hr' ? 'reject' : 'approve', 'Again');
        expect([again.status, again.body.error], key).toEqual([409, 'That request was already approved by Fatima Khan.']);
      }
      expect(await balance('employee', 'CL')).toMatchObject({ taken: 2, held: 0.5 });
    });

    it('rejects with a reason, and the days are available again', async () => {
      expect((await decide('manager', kept.arjunAfternoon!.id, 'reject', '  ')).status).toBe(400);
      const rejected = await decide('manager', kept.arjunAfternoon!.id, 'reject', 'The quarter closes that afternoon');
      expect(rejected.body).toMatchObject({ status: 'rejected', settled: true, decisionNote: 'The quarter closes that afternoon' });
      expect(await balance('employee', 'CL')).toMatchObject({ taken: 2, held: 0, available: 10 });
      expect((await storedAccount('employee'))!.bookings.map((b) => b.requestId)).not.toContain(kept.arjunAfternoon!.id);
      expect((await auditOf('leave.rejected')).at(-1)?.summary).toMatch(/Rejected Arjun Das's half a day of Casual leave \(Friday 11 December, second half\): The quarter closes that afternoon/);
    });

    it('lets a person cancel their own request while it waits, and after approval until its first day', async () => {
      // Someone else's request is not theirs to cancel, or even to know of.
      expect((await cancel('divya', kept.arjunMorning!.id)).status).toBe(404);
      expect((await cancel('manager', kept.arjunMorning!.id)).status).toBe(404);
      const waiting = await cancel('employee', kept.arjunMorning!.id);
      expect(waiting.body).toMatchObject({ status: 'cancelled', settled: true, decidedByName: 'Arjun Das' });
      expect(await balance('employee', 'SL')).toMatchObject({ held: 0, available: 8 });
      expect((await cancel('employee', kept.arjunMorning!.id)).body.error).toBe('That request is already cancelled.');

      // Approved for Thursday, and it is still Monday: he may take it back himself.
      const thursday = await approved('manager', await asked('employee', 'SL', D(3)));
      expect(await balance('employee', 'SL')).toMatchObject({ taken: 1, available: 7 });
      expect((await cancel('employee', thursday.id)).body).toMatchObject({ status: 'cancelled', settled: true });
      expect(await balance('employee', 'SL')).toMatchObject({ taken: 0, held: 0, available: 8 });
      expect((await auditOf('leave.cancelled')).at(-1)?.summary).toBe('Arjun Das cancelled their approved Sick leave (Thursday 10 December).');
    });

    it('sends a request from HR, an Admin or a top manager to another HR or Admin, never to themselves or downwards', async () => {
      // Rahul (HR) asks. He cannot approve it, and neither can any manager.
      const rahul = await asked('hr', 'CL', D(3));
      expect((await decide('hr', rahul.id, 'approve')).status).toBe(403);
      expect((await decide('manager', rahul.id, 'approve')).status).toBe(404);
      expect((await inboxOf('hr')).map((item) => item.id)).not.toContain(rahul.id);
      expect((await approved('admin', rahul)).decidedByName).toBe('Anita Menon');

      // Fatima manages Vivek: her request is not his to decide. HR decides it.
      const fatima = await asked('manager', 'CL', D(4));
      expect((await decide('lead', fatima.id, 'approve')).status).toBe(404);
      expect((await decide('manager', fatima.id, 'approve')).status).toBe(403);
      expect((await approved('hr', fatima)).decidedByName).toBe('Rahul Nair');
    });

    it('keeps a request whose policy says "HR only" away from managers', async () => {
      // Imran is moved to the policy HR decides. What he was granted stays; nothing new is granted.
      await (await person('hr')).post('/leave-policies/assign', { policyId: made.get('HR decides'), employeeIds: [await idByKey('imran')] });
      expect(await balance('imran', 'CL')).toMatchObject({ granted: 12 });
      const request = await asked('imran', 'CL', D(8));
      expect(request.approver).toBe('hr');
      // His earlier requests still go to his managers. This one does not.
      expect((await inboxOf('lead')).map((item) => item.id)).not.toContain(request.id);
      expect((await inboxOf('lead')).filter((item) => item.employeeName === 'Imran Sheikh')).toHaveLength(3);
      expect((await decide('lead', request.id, 'approve')).status).toBe(404);
      expect((await decide('manager', request.id, 'reject', 'No')).status).toBe(404);
      expect((await inboxOf('hr')).map((item) => item.id)).toContain(request.id);
      await approved('hr', request);
      // Sick leave is not in his policy any more: what he has stays, and no more can be asked for.
      expect((await ask('imran', 'SL', D(9))).body.fields).toEqual({ leaveTypeId: 'Your leave policy does not include Sick leave.' });
      const sick = (await accountOf('admin', 'imran')).body.rows.find((row) => row.type.code === 'SL')!;
      expect([sick.entry, sick.balance.held]).toEqual([null, 2]);
    });

    it('a cancel arriving in the middle of an approval ends with the days free', async () => {
      const leave = await import('./services/leave');
      const request = kept.divyaSick!;
      // The approval has been decided and not yet applied to the account: the server is between the two writes.
      await mod.db().leaveRequests.updateOne({ _id: request.id }, { $set: { status: 'approved', settled: false, decidedBy: await idByKey('lead'), decidedByName: 'Vivek Sharma', decidedAt: moment(MON, '10:00') } });
      expect((await storedAccount('divya'))!.bookings.find((b) => b.requestId === request.id)?.state).toBe('held');
      // Divya cancels at that moment. Then the approval's second write arrives, late.
      expect((await cancel('divya', request.id)).body).toMatchObject({ status: 'cancelled', settled: true });
      await leave.settleLeave(request.id);
      expect((await storedAccount('divya'))!.bookings.map((b) => b.requestId)).toEqual([kept.divyaCasual!.id]);
      expect(await balance('divya', 'SL')).toMatchObject({ taken: 0, held: 0, available: 8 });
      expect(await storedRequest(request.id)).toMatchObject({ status: 'cancelled', settled: true });
    });

    it('a stop at each step of sending and deciding is finished on restart', async () => {
      const leave = await import('./services/leave');
      const sneha = await idByKey('sneha');
      const blank = { employeeId: sneha, leaveTypeId: typeId('CL'), leaveYear: 2026, dayPart: 'full' as const, days: 1, reason: 'A day at home', approver: 'manager' as const, settled: false, submittedAt: moment(MON, '10:00'), decidedBy: null, decidedByName: null, decidedAt: null, decisionNote: '' };

      // 1. Stopped after the request was stored and before its days were held: it never happened.
      await mod.db().leaveRequests.insertOne({ _id: 'lvr_stoppedearly', ...blank, startDate: D(7), endDate: D(7), charged: [D(7)], status: 'submitting' });
      // Nobody is shown it, and reading the list a moment later does not clear away a request that may still be on its way.
      expect((await listOf('sneha')).body.items).toEqual([]);
      expect(await storedRequest('lvr_stoppedearly')).not.toBeNull();
      expect(await leave.settleLeaveUnfinished()).toBe(1);
      expect(await storedRequest('lvr_stoppedearly')).toBeNull();
      expect(await balance('sneha', 'CL')).toMatchObject({ held: 0, available: 6 });

      // 2. Stopped after the days were held and before the request was marked as sent: it is sent.
      await mod.db().leaveRequests.insertOne({ _id: 'lvr_stoppedlate', ...blank, submittedAt: moment(MON, '09:59'), startDate: D(7), endDate: D(7), charged: [D(7)], status: 'submitting' });
      await mod.db().leaveAccounts.updateOne({ _id: `${sneha}|2026` }, { $push: { bookings: { requestId: 'lvr_stoppedlate', leaveTypeId: typeId('CL'), startDate: D(7), endDate: D(7), dayPart: 'full', days: 1, state: 'held' } }, $inc: { version: 1 } });
      await leave.settleLeaveUnfinished();
      expect(await storedRequest('lvr_stoppedlate')).toMatchObject({ status: 'pending', settled: true });
      expect((await listOf('sneha')).body.items.map((item) => item.id)).toEqual(['lvr_stoppedlate']);
      expect(await balance('sneha', 'CL')).toMatchObject({ held: 1, available: 5 });

      // 3. Stopped between an approval and its being applied to the account: the days become taken.
      await mod.db().leaveRequests.updateOne({ _id: 'lvr_stoppedlate' }, { $set: { status: 'approved', settled: false, decidedBy: await idByKey('admin'), decidedByName: 'Anita Menon', decidedAt: moment(MON, '10:00') } });
      await leave.settleLeaveUnfinished();
      expect(await storedRequest('lvr_stoppedlate')).toMatchObject({ status: 'approved', settled: true });
      expect(await balance('sneha', 'CL')).toMatchObject({ taken: 1, held: 0, available: 5 });
      // Settling again changes nothing.
      const version = (await storedAccount('sneha'))!.version;
      await leave.settleLeave('lvr_stoppedlate');
      expect(await leave.settleLeaveUnfinished()).toBe(0);
      expect((await storedAccount('sneha'))!.version).toBe(version);

      // 4. Stopped between a rejection and its being applied: reading the requests finishes it, and the days are free.
      const second = await asked('sneha', 'CL', D(8));
      await mod.db().leaveRequests.updateOne({ _id: second.id }, { $set: { status: 'rejected', settled: false, decisionNote: 'Not that week' } });
      expect((await listOf('sneha')).body.items.map((item) => [item.id, item.status])).toEqual([
        [second.id, 'rejected'],
        ['lvr_stoppedlate', 'approved'],
      ]);
      expect(await storedRequest(second.id)).toMatchObject({ settled: true });
      expect(await balance('sneha', 'CL')).toMatchObject({ taken: 1, held: 0, available: 5 });

      // 5. A request abandoned minutes ago is cleared away when requests are next read.
      await mod.db().leaveRequests.insertOne({ _id: 'lvr_abandoned', ...blank, submittedAt: moment(MON, '09:50'), startDate: D(9), endDate: D(9), charged: [D(9)], status: 'submitting' });
      await listOf('sneha');
      expect(await storedRequest('lvr_abandoned')).toBeNull();
    });

    it('lets HR adjust a balance with a reason, in one checked write, and never their own', async () => {
      setNow(MON, '11:00');
      const added = await adjust('hr', 'employee', 'CL', 2);
      expect(added.status).toBe(201);
      expect(added.body.rows[0]!.balance).toMatchObject({ granted: 12, adjusted: 2, taken: 2, balance: 12, available: 12 });
      expect(added.body.entries.at(-1)).toMatchObject({ kind: 'adjustment', days: 2, byName: 'Rahul Nair', note: 'Compensation for the stock-taking weekend', typeName: 'Casual leave' });
      expect((await auditOf('leave.adjusted')).at(-1)).toMatchObject({ employeeId: await idByKey('employee'), summary: 'Added 2 days of Casual leave to Arjun Das\'s leave for 2026: Compensation for the stock-taking weekend', before: { available: 10 }, after: { available: 12 } });

      // More cannot be taken off than is available; a reason is needed; days come in halves.
      const tooMany = await adjust('hr', 'employee', 'CL', -12.5);
      expect([tooMany.status, tooMany.body.fields?.days]).toEqual([422, 'They have 12 days of Casual leave available, so 12.5 days cannot be taken off.']);
      expect((await adjust('hr', 'employee', 'CL', 1, 'ok')).body.fields).toEqual({ note: 'Say why, in a few words.' });
      expect((await adjust('hr', 'employee', 'CL', 0.25)).body.fields).toHaveProperty('days');
      expect((await adjust('hr', 'employee', 'CL', 0)).body.fields).toHaveProperty('days');
      expect((await adjust('hr', 'employee', 'CL', 1, undefined, 2031)).status).toBe(422);
      expect((await adjust('hr', 'employee', 'CL', -0.5, 'Half a day taken in error')).status).toBe(201);
      expect(await balance('employee', 'CL')).toMatchObject({ adjusted: 1.5, available: 11.5 });

      // HR cannot add days to themselves. The Admin can do it for them.
      const own = await adjust('hr', 'hr', 'CL', 5, 'I worked the weekend');
      expect([own.status, own.body.error]).toEqual([403, OWN_RECORD_MESSAGE]);
      expect(await balance('hr', 'CL')).toMatchObject({ adjusted: 0 });
      expect((await adjust('admin', 'hr', 'CL', 1, 'Worked the stock-taking Sunday')).status).toBe(201);
    });
  });

  describe('leave and attendance', () => {
    it('marks the days of a request that is still waiting, and reads them as they would without it', async () => {
      // Joseph asks for Wednesday to Friday of next week unpaid. Thursday is a holiday on his calendar: two days.
      kept.josephUnpaid = await asked('joseph', 'LOP', D(9), D(11));
      expect(kept.josephUnpaid).toMatchObject({ days: 2, charged: [D(9), D(11)] });
      const days = (await monthOf('joseph')).days;
      expect([days[15], days[16], days[17]].map((d) => [d!.status, d!.flags, d!.leave])).toEqual([
        ['upcoming', ['pending_leave'], null],
        ['holiday', [], null],
        ['upcoming', ['pending_leave'], null],
      ]);
      await approved('admin', kept.josephUnpaid);
      const after = (await monthOf('joseph')).days;
      expect([after[15], after[16], after[17]].map((d) => [d!.status, d!.flags, d!.leave?.name ?? null])).toEqual([
        ['leave', [], 'Unpaid leave'],
        ['holiday', [], null],
        ['leave', [], 'Unpaid leave'],
      ]);
      // Sneha has her Wednesday morning off, approved by her manager, the Admin.
      kept.snehaMorning = await approved('admin', await asked('sneha', 'SL', D(2), D(2), { dayPart: 'first_half' }));
      // Divya's three days are approved by her team lead.
      await approved('lead', kept.divyaCasual!);
    });

    it('reads a day of approved leave as leave, on the home page too, and from its first day only HR can cancel it', async () => {
      setNow(D(1), '09:05');
      const home = (await (await person('employee')).get<MyDashboardPayload>('/dashboard/me')).body;
      expect(home.today.day).toMatchObject({ date: D(1), status: 'leave', leave: { units: 1, part: 'full', name: 'Casual leave' } });
      expect(home.leave).toMatchObject({ yearLabel: '2026', hasPolicy: true, waiting: [] });
      expect(home.leave.balances.map((row) => [row.type.code, row.balance.available])).toEqual([
        ['CL', 11.5],
        ['EL', 15],
        ['SL', 8],
        ['LOP', 0],
      ]);
      expect(home.leave.upcoming.map((row) => [row.id, row.typeName, row.cancel])).toEqual([[kept.arjunCasual!.id, 'Casual leave', 'no']]);

      const tooLate = await cancel('employee', kept.arjunCasual!.id);
      expect([tooLate.status, tooLate.body.error]).toEqual([409, 'This leave has already started, so only HR can cancel it now.']);
      expect((await cancel('manager', kept.arjunCasual!.id, 'He came in after all')).status).toBe(404);
      // HR can, and has to say why.
      expect((await cancel('hr', kept.arjunCasual!.id)).body.fields).toEqual({ reason: 'Say why this leave is cancelled.' });
      expect((await storedRequest(kept.arjunCasual!.id))!.status).toBe('approved');

      // Yesterday has passed: casual leave cannot start there, and sick leave, which may start a week back, can.
      expect((await preview('divya', 'CL', D(0))).errors.startDate).toBe('Casual leave cannot start on a day that has passed.');
      expect((await preview('divya', 'SL', D(0))).errors).toEqual({});
    });

    it('a punch on a leave day: the day stays leave, and HR is shown that they worked', async () => {
      setNow(D(1), '09:30');
      await punch('employee', 'check-in');
      setNow(D(1), '13:00');
      const out = await punch('employee', 'check-out');
      expect(out.day).toMatchObject({ status: 'leave', flags: ['worked_on_leave'], units: { worked: 0, leave: 1, absent: 0, unresolved: 0 }, workedMinutes: 210 });
    });

    it('a half-day leave with a worked half: half leave, half present, and not late for the half that is leave', async () => {
      setNow(D(2), '13:00');
      await punch('sneha', 'check-in');
      setNow(D(2), '17:30');
      const out = await punch('sneha', 'check-out');
      expect(out.day).toMatchObject({ status: 'half_day', flags: ['half_day_leave'], units: { worked: 0.5, leave: 0.5, absent: 0, unresolved: 0 }, leave: { units: 0.5, part: 'first_half', name: 'Sick leave' } });
    });

    it('adds leave into the month, and the month still accounts for every working day', async () => {
      setNow(D(3), '21:00');
      const arjun = await monthOf('employee');
      // Monday he did not come in; Tuesday and Wednesday are leave (he worked a little on Tuesday); Thursday he was absent.
      expect(arjun.days.slice(6, 10).map((d) => d.status)).toEqual(['absent', 'leave', 'leave', 'absent']);
      expect(arjun.summary).toMatchObject({ workingDays: 4, leaveDays: 2, unpaidLeaveDays: 0, absentDays: 2, presentDays: 0 });
      expect(accountedFor(arjun.summary)).toBe(arjun.summary.workingDays);
      const sneha = await monthOf('sneha');
      // Her hours are flexible, so Thursday is not over until midnight: three days are counted so far.
      expect(sneha.summary).toMatchObject({ workingDays: 3, leaveDays: 0.5, halfDays: 1, absentDays: 2 });
      expect(accountedFor(sneha.summary)).toBe(sneha.summary.workingDays);
    });

    it('lets HR cancel leave that has started, with the reason, and the days are available again', async () => {
      setNow(D(6), '11:00');
      // Divya's leave began yesterday. She can no longer cancel it herself.
      expect((await cancel('divya', kept.divyaCasual!.id)).status).toBe(409);
      expect(await balance('divya', 'CL')).toMatchObject({ taken: 3, available: 9 });
      const decided = (await listOf('hr', '?view=decided')).body.items as LeaveRow[];
      expect(decided.find((row) => row.id === kept.divyaCasual!.id)).toMatchObject({ status: 'approved', cancel: 'with_reason' });
      expect(decided.find((row) => row.status === 'rejected')).toMatchObject({ cancel: 'no' });

      const done = await cancel('hr', kept.divyaCasual!.id, 'She was called in for the audit');
      expect(done.body).toMatchObject({ status: 'cancelled', settled: true, decidedByName: 'Rahul Nair', decisionNote: 'She was called in for the audit' });
      expect(await balance('divya', 'CL')).toMatchObject({ taken: 0, held: 0, available: 12 });
      expect((await auditOf('leave.cancelled')).at(-1)).toMatchObject({ actor: { name: 'Rahul Nair' }, summary: 'Cancelled Divya Thomas\'s approved Casual leave (Saturday 12 December to Monday 14 December): She was called in for the audit' });
      // Her Saturday reads as it would without the leave: she was not in.
      expect((await monthOf('divya')).days[11]).toMatchObject({ status: 'absent', leave: null });
      // HR does not cancel a request that is still waiting: rejecting it says why.
      expect((await cancel('hr', kept.imranUnpaid!.id, 'No')).body.error).toMatch(/Reject it instead/);
    });

    it('shows whoever changes a schedule or a holiday the leave requests it touches', async () => {
      setNow(D(7), '09:00');
      const hr = await person('hr');
      // A new schedule for Joseph from Thursday, in the middle of his approved leave.
      const given = await hr.post<AssignmentResult>('/schedule-assignments', { employeeIds: [await idByKey('joseph')], scheduleId: null, rules: { ...exampleA(ZONE), name: 'Joseph’s hours' }, effectiveFrom: D(10), note: '' });
      expect(given.body.assigned).toHaveLength(1);
      expect(given.body.leave).toEqual([{ employeeName: 'Joseph Mathew', typeName: 'Unpaid leave', startDate: D(9), endDate: D(11), dayPart: 'full', days: 2, status: 'approved' }]);

      // Founders' Day moves from Thursday to the Monday after. No day that has begun changes, but Joseph's leave includes it.
      const move = { date: D(14), name: 'Founders’ Day', type: 'company', description: '' };
      const refused = await hr.patch<ErrorPayload>(`/holidays/${made.get('Founders’ Day')}`, move);
      expect([refused.status, refused.body.code]).toEqual([409, CONFIRM_PAST]);
      expect(refused.body.error).toMatch(/asked for leave that includes that date/);
      expect(refused.body.details as HolidayEffect).toEqual({ people: 0, changes: [], leave: [{ employeeName: 'Joseph Mathew', typeName: 'Unpaid leave', startDate: D(9), endDate: D(11), dayPart: 'full', days: 2, status: 'approved' }] });
      expect((await hr.patch<Holiday>(`/holidays/${made.get('Founders’ Day')}`, { ...move, confirmPast: true })).status).toBe(200);
      expect((await auditOf('holiday.updated')).at(-1)?.summary).toMatch(/1 leave request includes the date; the days charged for them were left as they were/);
    });

    it('leave shows as Leave and never as Absent, also after a holiday inside it is moved', async () => {
      setNow(D(12), '20:00');
      const joseph = await monthOf('joseph');
      // Thursday is a working day again, and it reads Leave like the days around it.
      expect(joseph.days.slice(15, 18).map((d) => [d.status, d.leave?.name])).toEqual([
        ['leave', 'Unpaid leave'],
        ['leave', 'Unpaid leave'],
        ['leave', 'Unpaid leave'],
      ]);
      expect(joseph.summary).toMatchObject({ leaveDays: 3, unpaidLeaveDays: 3 });
      expect(accountedFor(joseph.summary)).toBe(joseph.summary.workingDays);
      // What was charged when it was sent stays as it was: two days.
      expect(await storedRequest(kept.josephUnpaid!.id)).toMatchObject({ days: 2, charged: [D(9), D(11)] });
      expect((await storedAccount('joseph'))!.bookings[0]).toMatchObject({ days: 2, state: 'taken' });
    });
  });

  describe('the turn of the leave year', () => {
    it('a range across the leave year is refused; next year can be asked for ahead, and its grant is made once', async () => {
      setNow(D(14), '10:00');
      expect((await ask('employee', 'LOP', '2026-12-30', '2027-01-02')).body.fields).toHaveProperty('endDate');
      expect(await storedAccount('employee', 2027)).toBeNull();

      kept.arjunJanuary = await asked('employee', 'EL', '2027-01-04', '2027-01-05');
      expect(kept.arjunJanuary).toMatchObject({ leaveYear: 2027, days: 2 });
      const next = (await storedAccount('employee', 2027))!;
      // The year's allowance, and nothing carried forward yet: the old year is not over.
      expect(next.entries.map((e) => [e.kind, e.days, e.note])).toEqual([
        ['grant', 12, 'Allowance for 2027'],
        ['grant', 15, 'Allowance for 2027'],
        ['grant', 8, 'Allowance for 2027'],
      ]);
      expect(next.carried).toBe(false);
      await asked('employee', 'CL', '2027-01-06');
      expect((await storedAccount('employee', 2027))!.entries).toHaveLength(3);
      expect(await balance('employee', 'EL', 2027)).toMatchObject({ granted: 15, carriedForward: 0, held: 2, available: 13 });
      // This year's account is untouched by it.
      expect(await balance('employee', 'EL')).toMatchObject({ granted: 15, held: 0, available: 15 });
    });

    it('carry-forward is capped and not made before the year starts', async () => {
      // 31 December: still nothing carried.
      setNow('2026-12-31', '23:00');
      expect(await balance('employee', 'EL', 2027)).toMatchObject({ carriedForward: 0 });

      // 2 January: the fifteen days of earned leave left over come across, up to the policy's ten. Casual leave carries nothing.
      setNow('2027-01-02', '10:00');
      const mine = (await accountOf('employee')).body;
      expect(mine).toMatchObject({ leaveYear: 2027, currentYear: 2027 });
      expect(mine.years.map((y) => y.year)).toEqual([2026, 2027, 2028]);
      expect(await balance('employee', 'EL')).toMatchObject({ granted: 15, carriedForward: 10, held: 2, available: 23 });
      expect(await balance('employee', 'CL')).toMatchObject({ granted: 12, carriedForward: 0 });
      expect(mine.entries.find((e) => e.kind === 'carry_forward')).toMatchObject({ days: 10, typeName: 'Earned leave', note: 'Carried forward from 2026' });

      // It is written into the account with the next change to it, once.
      expect((await storedAccount('employee', 2027))!.carried).toBe(false);
      expect((await adjust('hr', 'employee', 'EL', 1, 'Worked on New Year’s Day', 2027)).status).toBe(201);
      expect((await adjust('hr', 'employee', 'EL', 1, 'Worked on the second too', 2027)).status).toBe(201);
      const stored = (await storedAccount('employee', 2027))!;
      expect(stored.carried).toBe(true);
      expect(stored.entries.filter((e) => e.kind === 'carry_forward').map((e) => [e.leaveTypeId, e.days])).toEqual([[typeId('EL'), 10]]);
      expect(await balance('employee', 'EL')).toMatchObject({ granted: 15, carriedForward: 10, adjusted: 2, available: 25 });
    });

    it('closes the year that is over, and fixes the month the leave year starts in', async () => {
      // Sick leave may start a week back, but not in a leave year that has ended.
      expect((await ask('employee', 'SL', '2026-12-30')).body.fields).toEqual({ startDate: 'That leave year is over. Ask HR to put it right.' });
      expect((await adjust('hr', 'employee', 'CL', 1, 'A day for last year', 2026)).status).toBe(422);
      // Last year can still be read, as it ended.
      expect(await balance('employee', 'CL', 2026)).toMatchObject({ granted: 12, adjusted: 1.5, taken: 2, balance: 11.5 });

      const admin = await person('admin');
      const company = (await admin.get<CompanySettings>('/settings/company')).body;
      const moved = await admin.patch<ErrorPayload>('/settings/company', { ...company, leaveYearStartMonth: 4 });
      expect([moved.status, Object.keys(moved.body.fields ?? {})]).toEqual([422, ['leaveYearStartMonth']]);
      expect((await admin.patch('/settings/company', { ...company, name: 'Delta (sample) Ltd' })).status).toBe(200);
    });
  });

  describe('housekeeping', () => {
    it('lists a person’s requests to them, and to those who may see them', async () => {
      const mine = (await listOf('employee')).body;
      expect(mine).toMatchObject({ view: 'mine', page: 1, total: 6 });
      // Newest first: the two for January, sent in the same test minute. He can still cancel what has not started.
      expect(mine.items.slice(0, 2).map((row) => `${row.typeCode} ${row.startDate} ${row.status} ${row.cancel}`).sort()).toEqual(['CL 2027-01-06 pending yes', 'EL 2027-01-04 pending yes']);
      expect(mine.items.find((row) => row.id === kept.arjunCasual!.id)).toMatchObject({ status: 'approved', cancel: 'no', employeeName: 'Arjun Das' });

      const arjun = await idByKey('employee');
      expect((await listOf('manager', `?view=person&employeeId=${arjun}`)).body.total).toBe(6);
      expect((await listOf('hr', `?view=person&employeeId=${arjun}`)).body.total).toBe(6);
      expect((await listOf('divya', `?view=person&employeeId=${arjun}`)).status).toBe(404);
      expect((await listOf('lead', `?view=person&employeeId=${arjun}`)).status).toBe(404);
      expect((await listOf('manager', '?view=person')).status).toBe(422);
      expect((await listOf('employee', '?view=everything')).status).toBe(400);
    });

    it('archives a kind of leave without touching what was booked, and fixes paid or unpaid once it has been used', async () => {
      const hr = await person('hr');
      const casual = TYPES[0];
      const unpaid = await hr.patch<ErrorPayload>(`/leave-types/${typeId('CL')}`, { ...casual, paid: false, archived: false });
      expect([unpaid.status, Object.keys(unpaid.body.fields ?? {})]).toEqual([422, ['paid']]);
      expect((await hr.patch<LeaveType>(`/leave-types/${typeId('CL')}`, { ...casual, name: 'Casual leave', tone: 'violet', archived: false })).body).toMatchObject({ tone: 'violet', paid: true });

      const sick = TYPES[2];
      expect((await hr.patch<LeaveType>(`/leave-types/${typeId('SL')}`, { ...sick, archived: true })).body.archived).toBe(true);
      expect((await ask('employee', 'SL', '2027-01-07')).body.fields).toEqual({ leaveTypeId: 'Choose a kind of leave.' });
      // What Arjun has of it is still shown; no more is granted, and it is no longer part of what he can ask for.
      const row = (await accountOf('employee')).body.rows.find((r) => r.type.code === 'SL')!;
      expect([row.type.archived, row.entry, row.balance.granted]).toEqual([true, null, 8]);
      expect((await hr.patch<LeaveType>(`/leave-types/${typeId('SL')}`, { ...sick, archived: false })).body.archived).toBe(false);
      expect((await auditOf('leave_type.archived')).length + (await auditOf('leave_type.restored')).length).toBe(2);
    });

    it('deletes only a policy nobody is on, and moves the default by hand', async () => {
      const hr = await person('hr');
      const inUse = await hr.delete<ErrorPayload>(`/leave-policies/${made.get('HR decides')}`);
      expect([inUse.status, inUse.body.error]).toEqual([409, '1 person is on "HR decides". Move them to another policy first.']);
      const spare = await hr.post<LeavePolicy>('/leave-policies', { name: 'Interns', approver: 'hr', entries: [{ ...startingEntry(typeId('CL')), annualDays: 6 }] });
      expect((await hr.post(`/leave-policies/${spare.body.id}/default`)).status).toBe(204);
      expect((await hr.get<LeaveSetupPayload>('/leave-policies')).body.policies.filter((p) => p.isDefault).map((p) => p.name)).toEqual(['Interns']);
      expect((await hr.delete(`/leave-policies/${spare.body.id}`)).status).toBe(204);
      expect((await hr.get<LeaveSetupPayload>('/leave-policies')).body.policies.some((p) => p.isDefault)).toBe(false);
      expect((await hr.post(`/leave-policies/${made.get('Standard')}/default`)).status).toBe(204);
      expect((await hr.post('/leave-policies/lvp_000000000000/default')).status).toBe(404);
    });

    it('puts a new person on the default policy and opens their account with a pro-rated first year', async () => {
      const hr = await person('hr');
      const added = await hr.post<TemporaryPasswordPayload & ErrorPayload>('/employees', { name: 'Tara Bose', email: 'tara.bose@delta.test', phone: '', role: 'Employee', departmentId: null, designation: 'Analyst', managerId: null, joinDate: '2027-07-10', schedule: null });
      expect(added.status, added.body?.error ?? '').toBe(201);
      expect(added.body.employee.leavePolicyId).toBe(made.get('Standard'));
      // Joining in July 2027: six months of the leave year are left.
      const account = (await mod.db().leaveAccounts.findOne({ _id: `${added.body.employee.id}|2027` }))!;
      expect(account.entries.map((e) => [e.kind, e.days])).toEqual([
        ['grant', 6],
        ['grant', 7.5],
        ['grant', 4],
      ]);
      expect(account.entries[0]!.note).toBe('Allowance for 2027, pro-rated from 10 Jul 2027');
    });

    it('never left a request half sent, or an account that disagrees with its requests', async () => {
      const leave = await import('./services/leave');
      expect(await leave.settleLeaveUnfinished()).toBe(0);
      expect(await mod.db().leaveRequests.countDocuments({ $or: [{ status: 'submitting' }, { settled: false }] })).toBe(0);
      // Every booking belongs to a live request in the state its request says, and every live request has its booking.
      const accounts = await mod.db().leaveAccounts.find().toArray();
      const live = await mod.db().leaveRequests.find({ status: { $in: ['pending', 'approved'] } }).toArray();
      const booked = accounts.flatMap((account) => account.bookings.map((b) => `${account.employeeId}|${account.leaveYear}|${b.requestId}|${b.days}|${b.state}`)).sort();
      expect(booked).toEqual(live.map((r) => `${r.employeeId}|${r.leaveYear}|${r._id}|${r.days}|${r.status === 'approved' ? 'taken' : 'held'}`).sort());
    });
  });
});
