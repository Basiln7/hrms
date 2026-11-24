/*
 * End-to-end tests of attendance corrections (Phase 6) against a real MongoDB. The clock is
 * set by the tests and only moves forward through the file: a Monday of punches, then four
 * days of requests, decisions and direct edits on top of them.
 *
 * Which corrections fit a day, and whether their times make sense, is tested exhaustively in
 * shared. Here it is what the API must hold however requests arrive: one open request per
 * day, a decision made once, a correction applied once, the original never lost, and nobody
 * deciding what is not theirs to decide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  DAY_CHANGED,
  exampleA,
  OWN_RECORD_MESSAGE,
  zonedToInstant,
  type AssignmentResult,
  type AttendanceCalendarPayload,
  type CorrectionInboxItem,
  type CorrectionInput,
  type CorrectionListPayload,
  type CorrectionRequest,
  type CorrectionType,
  type DayDetailPayload,
  type EmployeeRow,
  type ErrorPayload,
  type MePayload,
  type MyDashboardPayload,
  type TodayPayload,
} from '@delta-hrms/shared';
import { boot, Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

const ZONE = 'Asia/Kolkata';
const MON = '2026-12-07';
const day = (n: number) => addDays(MON, n);
const [TUE, WED, THU, FRI] = [day(1), day(2), day(3), day(4)];

const moment = (date: string, time: string) => zonedToInstant(date, time, ZONE).toISOString();
const setNow = (date: string, time: string) => mod.clock.setTestNow(moment(date, time));

beforeAll(async () => {
  await boot('corrections');
  if (!reachable) return;
  setNow(MON, '05:00');
  await resetToSample();
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

const punch = async (key: string, action: 'check-in' | 'check-out') => {
  const answer = await (await person(key)).post<TodayPayload & ErrorPayload>(`/attendance/${action}`);
  expect(answer.status, `${key} ${action}: ${answer.body?.error ?? ''}`).toBe(200);
  return answer.body;
};
/** One person's whole day: in at one time, out at another (or left open). */
async function work(key: string, date: string, inTime: string, outTime: string | null) {
  setNow(date, inTime);
  await punch(key, 'check-in');
  if (!outTime) return;
  setNow(date, outTime);
  await punch(key, 'check-out');
}

const ask = (key: string, date: string, type: CorrectionType, more: Partial<CorrectionInput> = {}) =>
  person(key).then((client) => client.post<CorrectionRequest & ErrorPayload>('/regularizations', { date, type, checkIn: null, checkOut: null, status: null, reason: 'Forgot at the client site', ...more }));
/** Sends a request that must be accepted, and returns it. */
async function asked(key: string, date: string, type: CorrectionType, more: Partial<CorrectionInput> = {}) {
  const answer = await ask(key, date, type, more);
  expect(answer.status, `${key} ${type}: ${answer.body?.error ?? ''}`).toBe(201);
  return answer.body;
}
const inboxOf = async (key: string) => (await (await person(key)).get<CorrectionListPayload>('/regularizations?view=inbox')).body.items as CorrectionInboxItem[];
const approve = async (key: string, id: string, dayVersion: number, note = '') => (await person(key)).post<CorrectionRequest & ErrorPayload>(`/regularizations/${id}/approve`, { dayVersion, note });
/** Approves a request as someone, naming the version of the day their inbox shows. */
async function approved(key: string, request: CorrectionRequest) {
  const seen = (await inboxOf(key)).find((item) => item.id === request.id);
  expect(seen, `${key} should see ${request.id}`).toBeDefined();
  const answer = await approve(key, request.id, seen!.dayVersion);
  expect(answer.status, answer.body?.error ?? '').toBe(200);
  return answer.body;
}
const dayAs = async (viewer: string, key: string, date: string) => (await person(viewer)).get<DayDetailPayload & ErrorPayload>(`/attendance/days/${await idByKey(key)}/${date}`);
const dayOf = async (key: string, date: string) => (await dayAs('admin', key, date)).body;
const docOf = async (key: string, date: string) => (await mod.db().attendanceDays.findOne({ _id: `${await idByKey(key)}|${date}` }))!;
const auditOf = (action: string) => mod.db().audit.find({ action }).sort({ $natural: 1 }).toArray();

describe.skipIf(!reachable)('attendance corrections', () => {
  it('starts from a Monday of ordinary punches', async () => {
    // Joseph is put on rules that allow one correction a month, one day back, from Tuesday.
    setNow(MON, '08:00');
    const limited = { ...exampleA(ZONE), name: 'Limited corrections', corrections: { windowDays: 1, maxPerMonth: 1 } };
    const given = await (await person('hr')).post<AssignmentResult>('/schedule-assignments', { employeeIds: [await idByKey('joseph')], scheduleId: null, rules: limited, effectiveFrom: TUE, note: '' });
    expect(given.body.assigned).toHaveLength(1);

    await work('manager', MON, '09:00', null); // Fatima forgets to check out.
    await work('hr', MON, '09:00', '11:00'); // Rahul: two hours, counted absent.
    await work('employee', MON, '09:26', '18:30'); // Arjun: late, a full day.
    await work('divya', MON, '10:00', '15:00'); // Divya: five hours, a half-day.
    // Joseph and Sneha do not come in at all.

    setNow(TUE, '10:00');
    expect((await dayOf('manager', MON)).day).toMatchObject({ status: 'unresolved' });
    expect((await dayOf('hr', MON)).day).toMatchObject({ status: 'absent', workedMinutes: 120 });
    expect((await dayOf('employee', MON)).day).toMatchObject({ status: 'present', lateMinutes: 26, flags: ['late'] });
    expect((await dayOf('divya', MON)).day).toMatchObject({ status: 'half_day', workedMinutes: 300 });
    expect((await dayOf('joseph', MON)).day).toMatchObject({ status: 'absent', checkInAt: null });
  });

  describe('asking and deciding, kind by kind', () => {
    it('tells the person what they could ask for on a day, and nobody else', async () => {
      const mine = (await dayAs('employee', 'employee', MON)).body;
      expect(mine.requestable).toEqual({ types: ['incorrect_check_in', 'incorrect_check_out', 'late_explanation'], blocked: null });
      expect(mine).toMatchObject({ version: 2, pending: null, editable: false });
      // His manager and HR see the day, not his options. HR could edit it; the manager could not.
      expect((await dayAs('manager', 'employee', MON)).body).toMatchObject({ requestable: null, editable: false });
      expect((await dayAs('hr', 'employee', MON)).body).toMatchObject({ requestable: null, editable: true });
      // Tomorrow has nothing to correct.
      expect((await dayAs('employee', 'employee', WED)).body.requestable).toEqual({ types: [], blocked: 'A day that has not come yet has nothing to correct.' });
    });

    it('late entry explanation: decided by the manager, the day stays late and is excused', async () => {
      const request = await asked('employee', MON, 'late_explanation', { reason: 'The 08:10 train was cancelled' });
      expect(request).toMatchObject({ status: 'pending', settled: true, requested: { lateExcused: true }, original: { checkInAt: moment(MON, '09:26'), checkOutAt: moment(MON, '18:30'), override: null, lateExcused: false, status: 'present', version: 2 } });
      expect((await auditOf('correction.requested')).at(-1)).toMatchObject({ employeeId: await idByKey('employee'), actor: { name: 'Arjun Das' } });

      // The day is marked while the request waits, for him and for anyone who may see him.
      expect((await dayAs('employee', 'employee', MON)).body).toMatchObject({ pending: { id: request.id }, requestable: { types: [], blocked: 'A correction for this day is already waiting for a decision. Cancel it first to ask for something else.' } });
      expect([...(await dayOf('employee', MON)).day.flags].sort()).toEqual(['late', 'pending_correction']);

      const [item] = await inboxOf('manager');
      expect(item).toMatchObject({ id: request.id, employeeName: 'Arjun Das', employeeCode: 'EMP-0004', timeZone: ZONE, dayVersion: 2, problem: null, now: { status: 'present', lateMinutes: 26 }, after: { status: 'present', lateMinutes: 26, flags: ['late', 'late_excused'] } });
      expect((await (await person('manager')).get<MePayload>('/me')).body.approvalsWaiting).toBe(1);

      const decided = await approve('manager', request.id, 2, 'Fine, it happens');
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ status: 'approved', settled: true, decidedByName: 'Fatima Khan', decisionNote: 'Fine, it happens', decidedAt: moment(TUE, '10:00') });

      const doc = await docOf('employee', MON);
      expect(doc).toMatchObject({ lateExcused: true, version: 3, checkInAt: moment(MON, '09:26') });
      expect(doc.history.at(-1)).toEqual({
        at: moment(TUE, '10:00'),
        by: await idByKey('manager'),
        byName: 'Fatima Khan',
        kind: 'excused',
        before: { checkInAt: moment(MON, '09:26'), checkOutAt: moment(MON, '18:30'), override: null, lateExcused: false },
        after: { lateExcused: true },
        reason: 'The 08:10 train was cancelled',
        requestId: request.id,
      });
      expect((await dayOf('employee', MON)).day).toMatchObject({ status: 'present', lateMinutes: 26, flags: ['late', 'late_excused'] });
      expect((await auditOf('correction.approved')).at(-1)).toMatchObject({ summary: `Approved Arjun Das's request to correct ${MON} (late explanation).`, actor: { name: 'Fatima Khan' }, employeeId: await idByKey('employee') });
      expect((await (await person('manager')).get<MePayload>('/me')).body.approvalsWaiting).toBe(0);
    });

    it('incorrect check-in, then incorrect check-out: two corrections in a row, and the original still readable', async () => {
      const first = await approved('hr', await asked('employee', MON, 'incorrect_check_in', { checkIn: `${MON}T09:02` }));
      expect(first.decidedByName).toBe('Rahul Nair');
      expect((await dayOf('employee', MON)).day).toMatchObject({ status: 'present', checkInAt: moment(MON, '09:02'), lateMinutes: 0, flags: ['corrected'] });

      await approved('admin', await asked('employee', MON, 'incorrect_check_out', { checkOut: `${MON}T18:45` }));
      const doc = await docOf('employee', MON);
      expect(doc).toMatchObject({ checkInAt: moment(MON, '09:02'), checkOutAt: moment(MON, '18:45'), version: 5 });
      expect(doc.history.map((h) => h.kind)).toEqual(['check_in', 'check_out', 'excused', 'corrected', 'corrected']);
      // What he actually punched is the first two rows, untouched, and each correction says what it replaced.
      expect(doc.history[0]).toMatchObject({ kind: 'check_in', at: moment(MON, '09:26'), after: { checkInAt: moment(MON, '09:26') } });
      expect(doc.history[1]).toMatchObject({ kind: 'check_out', after: { checkOutAt: moment(MON, '18:30') } });
      expect(doc.history[3]).toMatchObject({ byName: 'Rahul Nair', before: { checkInAt: moment(MON, '09:26'), checkOutAt: moment(MON, '18:30') }, after: { checkInAt: moment(MON, '09:02') } });
      expect(doc.history[4]).toMatchObject({ byName: 'Anita Menon', before: { checkInAt: moment(MON, '09:02'), checkOutAt: moment(MON, '18:30') }, after: { checkOutAt: moment(MON, '18:45') } });

      // He reads the same history himself, without where each change came from.
      const mine = (await dayAs('employee', 'employee', MON)).body;
      expect(mine.record!.history.map((h) => [h.kind, h.byName])).toEqual([
        ['check_in', 'Arjun Das'],
        ['check_out', 'Arjun Das'],
        ['excused', 'Fatima Khan'],
        ['corrected', 'Rahul Nair'],
        ['corrected', 'Anita Menon'],
      ]);
      expect(JSON.stringify(mine.record)).not.toMatch(/"ip"|userAgent/);
    });

    it('half-day and absent corrections: the status is set by hand, the punches stay', async () => {
      // Divya reports to Vivek, who reports to Fatima: either may decide. Vivek does.
      const half = await asked('divya', MON, 'half_day_correction', { status: 'present', reason: 'Client visit all afternoon' });
      expect((await inboxOf('manager')).map((item) => item.id)).toContain(half.id);
      const item = (await inboxOf('lead')).find((entry) => entry.id === half.id)!;
      expect(item).toMatchObject({ now: { status: 'half_day' }, after: { status: 'present', workedMinutes: 300 }, dayVersion: 2 });
      await approved('lead', half);
      expect((await dayOf('divya', MON)).day).toMatchObject({ status: 'present', checkOutAt: moment(MON, '15:00'), workedMinutes: 300, units: { worked: 1, absent: 0 } });
      expect((await docOf('divya', MON)).history.at(-1)).toMatchObject({ kind: 'overridden', before: { override: null }, after: { override: 'present' } });

      // Joseph was never in. His manager is the Admin.
      const absent = await asked('joseph', MON, 'absent_correction', { status: 'half_day', reason: 'Worked from the bank until noon' });
      expect(absent.original).toMatchObject({ checkInAt: null, status: 'absent', version: 0 });
      await approved('admin', absent);
      const doc = await docOf('joseph', MON);
      expect(doc).toMatchObject({ checkInAt: null, checkOutAt: null, override: 'half_day', breaks: [], note: null, version: 1, employeeId: await idByKey('joseph'), date: MON });
      // The day is read by the rules he was on that Monday, not the ones he has now.
      expect((await mod.db().scheduleAssignments.findOne({ _id: doc.assignmentId! }))!.rules.name).toBe('General 9 to 6');
      expect(doc.history).toEqual([{ at: moment(TUE, '10:00'), by: await idByKey('admin'), byName: 'Anita Menon', kind: 'overridden', before: { checkInAt: null, checkOutAt: null, override: null, lateExcused: false }, after: { override: 'half_day' }, reason: 'Worked from the bank until noon', requestId: absent.id }]);
      expect((await dayOf('joseph', MON)).day).toMatchObject({ status: 'half_day', flags: ['corrected'], units: { worked: 0.5, absent: 0.5 } });
    });

    it('missing check-out and forgot attendance: the times asked for are set, and the day reads by its own rules', async () => {
      // Fatima reports to nobody: HR or an Admin decides.
      const out = await asked('manager', MON, 'missing_check_out', { checkOut: `${MON}T18:05` });
      expect((await inboxOf('hr')).find((item) => item.id === out.id)).toMatchObject({ now: { status: 'unresolved' }, after: { status: 'present', workedMinutes: 485 } });
      await approved('hr', out);
      expect((await dayOf('manager', MON)).day).toMatchObject({ status: 'present', checkOutAt: moment(MON, '18:05'), flags: ['corrected'] });

      // Sneha's hours are flexible: any time in the calendar day.
      const both = await asked('sneha', MON, 'forgot_attendance', { checkIn: `${MON}T10:00`, checkOut: `${MON}T18:40` });
      await approved('admin', both);
      expect((await dayOf('sneha', MON)).day).toMatchObject({ status: 'present', workedMinutes: 520, flags: ['corrected'] });
      expect((await docOf('sneha', MON)).history.map((h) => h.kind)).toEqual(['corrected']);
    });

    it('missing check-in: the day opens from the time given, and the person checks out themselves', async () => {
      setNow(TUE, '11:00');
      const request = await asked('imran', TUE, 'missing_check_in', { checkIn: `${TUE}T10:00`, reason: 'Phone was flat this morning' });
      expect((await inboxOf('lead')).find((item) => item.id === request.id)).toMatchObject({ now: { status: 'not_in' }, after: { status: 'working' }, dayVersion: 0 });
      await approved('lead', request);

      const today = (await (await person('imran')).get<TodayPayload>('/attendance/today')).body;
      expect(today).toMatchObject({ can: { checkIn: false, checkOut: true }, day: { status: 'working', checkInAt: moment(TUE, '10:00'), grossMinutes: 60 } });
      setNow(TUE, '19:05');
      expect((await punch('imran', 'check-out')).day).toMatchObject({ status: 'present', workedMinutes: 485 });
      expect((await docOf('imran', TUE)).history.map((h) => h.kind)).toEqual(['corrected', 'check_out']);
    });

    it('refuses what does not fit the day, with the reason beside the field', async () => {
      setNow(TUE, '19:10');
      const noType = await ask('employee', MON, 'missing_check_out', { checkOut: `${MON}T19:00` });
      expect(noType.status).toBe(422);
      expect(noType.body.fields).toEqual({ type: 'That kind of correction does not fit this day as it is now.' });
      const early = await ask('employee', MON, 'incorrect_check_in', { checkIn: `${MON}T05:00` });
      expect(early.body.fields?.checkIn).toMatch(/falls between 06:00/);
      const noReason = await ask('employee', MON, 'incorrect_check_in', { checkIn: `${MON}T09:00`, reason: '' });
      expect(noReason.body.fields).toEqual({ reason: 'Say why, in a few words.' });
      // Nothing but what the form holds: not a status, not someone else's id.
      const client = await person('employee');
      expect((await client.post('/regularizations', { date: MON, type: 'incorrect_check_in', checkIn: `${MON}T09:00`, checkOut: null, status: null, reason: 'A reason', employeeId: await idByKey('divya') })).status).toBe(400);
      expect((await client.post('/regularizations', { date: MON, type: 'pay_me_more', checkIn: null, checkOut: null, status: null, reason: 'A reason' })).status).toBe(400);
      expect(await mod.db().corrections.countDocuments({ status: 'pending' })).toBe(0);
    });
  });

  describe('who may decide', () => {
    let rahuls: CorrectionRequest;

    it('never the person who asked, and never a manager for a request from HR', async () => {
      // An Admin makes HR's account report to Fatima. That must not make Fatima HR's approver.
      const admin = await person('admin');
      const hrId = await idByKey('hr');
      const { id: _id, code: _code, departmentName: _d, managerName: _m, scheduleName: _s, employment: _e, status: _st, leavePolicyId: _l, mustChangePassword: _p, createdAt: _c, updatedAt: _u, lastLoginAt: _ll, ...details } = (await admin.get<EmployeeRow>(`/employees/${hrId}`)).body;
      expect((await admin.patch(`/employees/${hrId}`, { ...details, managerId: await idByKey('manager') })).status).toBe(200);

      rahuls = await asked('hr', MON, 'absent_correction', { status: 'half_day', reason: 'I was at the labour office' });
      expect((await inboxOf('manager')).map((item) => item.id)).not.toContain(rahuls.id);
      const throughManager = await approve('manager', rahuls.id, 2);
      const missing = await approve('manager', 'cor_000000000000', 2);
      expect([throughManager.status, missing.status]).toEqual([404, 404]);
      expect(throughManager.body).toEqual(missing.body);

      const own = await approve('hr', rahuls.id, 2);
      expect(own.status).toBe(403);
      expect(own.body.error).toBe('You cannot decide your own request. Someone else has to.');
      expect((await (await person('hr')).post<ErrorPayload>(`/regularizations/${rahuls.id}/reject`, { note: 'No' })).status).toBe(403);
      // It waits for the Admin, the only other HR or Admin.
      expect((await inboxOf('admin')).map((item) => item.id)).toEqual([rahuls.id]);
      expect((await inboxOf('hr')).map((item) => item.id)).toEqual([]);
    });

    it('a rejection needs its reason, and leaves the day alone', async () => {
      const admin = await person('admin');
      expect((await admin.post<ErrorPayload>(`/regularizations/${rahuls.id}/reject`, { note: ' ' })).status).toBe(400);
      expect((await admin.post<ErrorPayload>(`/regularizations/${rahuls.id}/reject`, {})).status).toBe(400);
      const rejected = await admin.post<CorrectionRequest>(`/regularizations/${rahuls.id}/reject`, { note: 'The visit was on Tuesday' });
      expect(rejected.body).toMatchObject({ status: 'rejected', settled: true, decidedByName: 'Anita Menon', decisionNote: 'The visit was on Tuesday' });
      expect(await docOf('hr', MON)).toMatchObject({ version: 2, override: null });
      expect((await dayOf('hr', MON)).day).toMatchObject({ status: 'absent', flags: expect.not.arrayContaining(['pending_correction', 'corrected']) as unknown });
      expect((await auditOf('correction.rejected')).at(-1)?.summary).toBe(`Rejected Rahul Nair's request to correct ${MON}: The visit was on Tuesday`);
      // Decided is decided.
      expect((await admin.post<ErrorPayload>(`/regularizations/${rahuls.id}/reject`, { note: 'Again' })).body.error).toBe('That request was already rejected by Anita Menon.');
      expect((await approve('admin', rahuls.id, 2)).status).toBe(409);
    });

    it('a manager only for their own people, an employee for nobody', async () => {
      const request = await asked('divya', MON, 'incorrect_check_out', { checkOut: `${MON}T15:30` });
      // Nisha manages Support; Divya is in Sales under Vivek. Arjun is nobody's manager.
      for (const outsider of ['nisha', 'employee']) {
        const answer = await approve(outsider, request.id, 3);
        expect(answer.status, outsider).toBe(404);
        expect(answer.body.error).toBe('That request does not exist.');
        expect((await (await person(outsider)).post(`/regularizations/${request.id}/reject`, { note: 'No' })).status).toBe(404);
      }
      expect((await (await person('employee')).get('/regularizations?view=inbox')).status).toBe(403);
      expect((await (await person('employee')).get('/regularizations?view=decided')).status).toBe(403);
      expect((await inboxOf('nisha')).map((item) => item.id)).toEqual([]);
      // Nothing was decided by any of that.
      expect((await mod.db().corrections.findOne({ _id: request.id }))!.status).toBe('pending');
      await approved('manager', request);
    });

    it('lets the person take a waiting request back, and nobody else', async () => {
      const request = await asked('hr', MON, 'absent_correction', { status: 'half_day', reason: 'Asking again with the right day' });
      expect((await (await person('employee')).post(`/regularizations/${request.id}/cancel`)).status).toBe(404);
      const cancelled = await (await person('hr')).post<CorrectionRequest>(`/regularizations/${request.id}/cancel`);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', decidedByName: 'Rahul Nair' });
      expect((await (await person('hr')).post<ErrorPayload>(`/regularizations/${request.id}/cancel`)).body.error).toBe('That request has already been cancelled.');
      expect((await approve('admin', request.id, 2)).body.error).toBe('That request was already cancelled.');
      expect((await dayOf('hr', MON)).day.flags).not.toContain('pending_correction');
    });
  });

  describe('one request per day, and limits', () => {
    it('stores one open request for a day, also when two arrive at the same instant', async () => {
      setNow(WED, '10:00');
      // Rahul did not come in on Tuesday.
      const both = await Promise.all([ask('hr', TUE, 'absent_correction', { status: 'present', reason: 'First of two' }), ask('hr', TUE, 'absent_correction', { status: 'half_day', reason: 'Second of two' })]);
      expect(both.map((answer) => answer.status).sort()).toEqual([201, 409]);
      expect(both.find((answer) => answer.status === 409)!.body.error).toMatch(/already waiting for a decision/);
      expect(await mod.db().corrections.countDocuments({ employeeId: await idByKey('hr'), date: TUE, status: 'pending' })).toBe(1);
      expect((await ask('hr', TUE, 'forgot_attendance', { checkIn: `${TUE}T09:00`, checkOut: `${TUE}T18:00` })).status).toBe(409);
      await (await person('hr')).post(`/regularizations/${both.find((answer) => answer.status === 201)!.body.id}/cancel`);
    });

    it('holds a person to their own schedule: how far back, and how many for the days of a month', async () => {
      // Joseph's rules since Tuesday: one day back, one correction a month. His Monday already used December's one.
      setNow(THU, '09:30');
      const tooOld = await ask('joseph', TUE, 'absent_correction', { status: 'present' });
      expect(tooOld.status).toBe(409);
      expect(tooOld.body.error).toBe('Your schedule lets you ask for a correction up to 1 day back: from Wednesday 9 December. For an older day, ask HR.');
      const tooMany = await ask('joseph', WED, 'absent_correction', { status: 'present' });
      expect(tooMany.status).toBe(409);
      expect(tooMany.body.error).toBe('Your schedule allows 1 correction for the days of one month, and December 2026 already has 1. Ask HR.');
      expect((await dayAs('joseph', 'joseph', WED)).body.requestable).toEqual({ types: [], blocked: tooMany.body.error });
      // Arjun's schedule has no monthly limit and reaches seven days back.
      expect((await dayAs('employee', 'employee', MON)).body.requestable?.blocked).toBeNull();
    });
  });

  describe('a decision is made once and applied once', () => {
    it('the same approval sent twice, or by two approvers at once, changes the day once', async () => {
      await work('employee', WED, '09:00', '18:00');
      setNow(THU, '10:00');
      const request = await asked('employee', WED, 'incorrect_check_out', { checkOut: `${WED}T18:40` });
      const [byHr, byAdmin] = await Promise.all([approve('hr', request.id, 2), approve('admin', request.id, 2)]);
      expect([byHr.status, byAdmin.status].sort()).toEqual([200, 409]);
      const loser = byHr.status === 409 ? byHr : byAdmin;
      expect(loser.body.error).toMatch(/^That request was already approved by (Rahul Nair|Anita Menon)\.$/);

      const again = await approve('manager', request.id, 2);
      expect(again.status).toBe(409);
      const doc = await docOf('employee', WED);
      expect(doc.history.filter((h) => h.requestId === request.id)).toHaveLength(1);
      expect(doc).toMatchObject({ version: 3, checkOutAt: moment(WED, '18:40') });
      expect(await auditOf('correction.approved').then((rows) => rows.filter((row) => row.targetId === request.id))).toHaveLength(1);
    });

    it('an approval against a day that has changed since it was opened is refused, and shows the day as it is', async () => {
      await work('divya', THU, '10:20', '19:00');
      setNow(FRI, '10:00');
      const request = await asked('divya', THU, 'late_explanation', { reason: 'School run' });
      const seen = (await inboxOf('lead')).find((item) => item.id === request.id)!;
      expect(seen.dayVersion).toBe(2);

      // Meanwhile HR corrects her check-out on that day.
      const edit = await (await person('hr')).post<DayDetailPayload>(`/attendance/days/${await idByKey('divya')}/${THU}/correct`, { checkIn: `${THU}T10:20`, checkOut: `${THU}T19:10`, override: null, lateExcused: false, reason: 'Stayed for the stock count', dayVersion: 2 });
      expect(edit.status).toBe(200);

      const stale = await approve('lead', request.id, seen.dayVersion);
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe(DAY_CHANGED);
      expect(stale.body.details).toMatchObject({ id: request.id, dayVersion: 3, now: { checkOutAt: moment(THU, '19:10') }, problem: null });
      expect((await mod.db().corrections.findOne({ _id: request.id }))!.status).toBe('pending');
      expect((await docOf('divya', THU)).lateExcused).toBe(false);

      expect((await approve('lead', request.id, 3)).status).toBe(200);
      expect((await dayOf('divya', THU)).day.flags).toEqual(expect.arrayContaining(['late', 'late_excused', 'corrected']));
    });

    it('a request that no longer fits the day can only be rejected', async () => {
      await work('employee', FRI, '09:30', '18:30');
      setNow(day(5), '10:00');
      const request = await asked('employee', FRI, 'late_explanation', { reason: 'Flat tyre' });
      // HR finds the gate log and corrects his check-in: the day is no longer late.
      await (await person('hr')).post(`/attendance/days/${await idByKey('employee')}/${FRI}/correct`, { checkIn: `${FRI}T09:00`, checkOut: `${FRI}T18:30`, override: null, lateExcused: false, reason: 'Gate log says nine', dayVersion: 2 });
      const item = (await inboxOf('manager')).find((entry) => entry.id === request.id)!;
      expect(item).toMatchObject({ dayVersion: 3, after: null, problem: 'The day has changed since this was asked for, and this kind of correction no longer fits it.' });
      const refused = await approve('manager', request.id, 3);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/can only be rejected/);
      expect((await (await person('manager')).post<CorrectionRequest>(`/regularizations/${request.id}/reject`, { note: 'Already put right by HR' })).body.status).toBe('rejected');
    });

    it('a stop between deciding and applying is finished later, once', async () => {
      const corrections = await import('./services/corrections');
      const request = await asked('sneha', TUE, 'absent_correction', { status: 'present', reason: 'Design review at the client' });
      // The server stops right after the decision is written and before the day is touched.
      await mod.db().corrections.updateOne({ _id: request.id }, { $set: { status: 'approved', settled: false, decidedBy: await idByKey('admin'), decidedByName: 'Anita Menon', decidedAt: moment(day(5), '10:00') } });
      expect(await mod.db().attendanceDays.findOne({ _id: `${await idByKey('sneha')}|${TUE}` })).toBeNull();

      // On start-up the unfinished approval is applied.
      expect(await corrections.settleUnfinished()).toBe(1);
      expect((await mod.db().corrections.findOne({ _id: request.id }))!.settled).toBe(true);
      expect((await dayOf('sneha', TUE)).day).toMatchObject({ status: 'present', flags: ['corrected'] });
      // Doing it again changes nothing, whether asked directly or with the request forced back to unfinished.
      expect(await corrections.settleUnfinished()).toBe(0);
      await mod.db().corrections.updateOne({ _id: request.id }, { $set: { settled: false } });
      expect(await corrections.settleUnfinished()).toBe(1);
      const doc = await docOf('sneha', TUE);
      expect(doc.history).toHaveLength(1);
      expect(doc.version).toBe(1);

      // Reading requests finishes one as well: nobody has to wait for a restart.
      const second = await asked('sneha', WED, 'absent_correction', { status: 'half_day', reason: 'Half a day at the printer' });
      await mod.db().corrections.updateOne({ _id: second.id }, { $set: { status: 'approved', settled: false, decidedBy: await idByKey('admin'), decidedByName: 'Anita Menon', decidedAt: moment(day(5), '10:00') } });
      const mine = (await (await person('sneha')).get<CorrectionListPayload>('/regularizations')).body;
      expect(mine.items.find((item) => item.id === second.id)).toMatchObject({ status: 'approved', settled: true });
      expect((await dayOf('sneha', WED)).day.status).toBe('half_day');
    });

    it('a check-out arriving during an approval loses nothing', async () => {
      const corrections = await import('./services/corrections');
      // Saturday. Imran checks in late and asks for the time to be put right while he is still at work.
      setNow(day(5), '10:30');
      await punch('imran', 'check-in');
      const request = await asked('imran', day(5), 'incorrect_check_in', { checkIn: `${day(5)}T10:00`, reason: 'Checked in after the stand-up' });
      // The decision is written; before the day is touched, his check-out arrives.
      await mod.db().corrections.updateOne({ _id: request.id }, { $set: { status: 'approved', settled: false, decidedBy: await idByKey('lead'), decidedByName: 'Vivek Sharma', decidedAt: moment(day(5), '19:00') } });
      setNow(day(5), '19:00');
      await punch('imran', 'check-out');
      await corrections.settleUnfinished();

      const doc = await docOf('imran', day(5));
      expect(doc).toMatchObject({ checkInAt: moment(day(5), '10:00'), checkOutAt: moment(day(5), '19:00'), version: 3 });
      expect(doc.history.map((h) => h.kind)).toEqual(['check_in', 'check_out', 'corrected']);
      // The correction's "before" is the day exactly as it was at that write, check-out included.
      expect(doc.history[2]).toMatchObject({ before: { checkInAt: moment(day(5), '10:30'), checkOutAt: moment(day(5), '19:00') }, after: { checkInAt: moment(day(5), '10:00') } });

      // And for real, both at once: whichever lands first, the check-out is on the day and the request is consistent with it.
      setNow(day(5), '10:40');
      await punch('divya', 'check-in');
      const live = await asked('divya', day(5), 'incorrect_check_in', { checkIn: `${day(5)}T10:00`, reason: 'Same stand-up' });
      setNow(day(5), '19:05');
      const [decision, checkOut] = await Promise.all([approve('lead', live.id, 1), (await person('divya')).post<TodayPayload>('/attendance/check-out')]);
      expect(checkOut.status).toBe(200);
      const after = await docOf('divya', day(5));
      expect(after.checkOutAt).toBe(moment(day(5), '19:05'));
      const state = (await mod.db().corrections.findOne({ _id: live.id }))!.status;
      if (decision.status === 200) expect([state, after.checkInAt]).toEqual(['approved', moment(day(5), '10:00')]);
      else {
        expect([decision.body.code, state, after.checkInAt]).toEqual([DAY_CHANGED, 'pending', moment(day(5), '10:40')]);
        // Left waiting by the race: she takes it back, so that what follows does not depend on who won.
        await (await person('divya')).post(`/regularizations/${live.id}/cancel`);
      }
    });
  });

  describe('corrections made directly by HR', () => {
    const correct = async (viewer: string, key: string, date: string, body: Record<string, unknown>) =>
      (await person(viewer)).post<DayDetailPayload & ErrorPayload>(`/attendance/days/${await idByKey(key)}/${date}/correct`, { checkIn: null, checkOut: null, override: null, lateExcused: false, reason: 'Confirmed with the client', dayVersion: 0, ...body });

    it('set the facts as they should be, in the same history, with HR’s reason', async () => {
      // Joseph did not come in on Wednesday. HR records the day he worked at the bank.
      const answer = await correct('hr', 'joseph', WED, { checkIn: `${WED}T09:00`, checkOut: `${WED}T18:00`, reason: '$checkInAt was never recorded: he was at the bank' });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ version: 1, day: { status: 'present', workedMinutes: 480, flags: ['corrected'] }, editable: true });
      const doc = await docOf('joseph', WED);
      // Text that looks like a field name is stored as the text it is.
      expect(doc.history).toEqual([{ at: moment(day(5), '19:05'), by: await idByKey('hr'), byName: 'Rahul Nair', kind: 'corrected', before: { checkInAt: null, checkOutAt: null, override: null, lateExcused: false }, after: { checkInAt: moment(WED, '09:00'), checkOutAt: moment(WED, '18:00') }, reason: '$checkInAt was never recorded: he was at the bank' }]);
      expect((await auditOf('attendance.corrected')).at(-1)).toMatchObject({ actor: { name: 'Rahul Nair' }, employeeId: await idByKey('joseph'), summary: `Corrected Joseph Mathew's attendance on ${WED}: $checkInAt was never recorded: he was at the bank`, after: { checkInAt: moment(WED, '09:00') } });
    });

    it('are not made over a day that has changed, nor without a reason, nor to no effect', async () => {
      const stale = await correct('hr', 'joseph', WED, { checkIn: `${WED}T09:00`, checkOut: `${WED}T17:00`, dayVersion: 0 });
      expect([stale.status, stale.body.code]).toEqual([409, DAY_CHANGED]);
      const same = await correct('hr', 'joseph', WED, { checkIn: `${WED}T09:00`, checkOut: `${WED}T18:00`, dayVersion: 1 });
      expect([same.status, same.body.fields]).toEqual([422, { day: 'Nothing would change: the day already reads like this.' }]);
      const backwards = await correct('hr', 'joseph', WED, { checkIn: `${WED}T19:00`, checkOut: `${WED}T18:00`, dayVersion: 1 });
      expect(backwards.body.fields).toEqual({ checkIn: 'The check-in has to be before the check-out at 18:00.' });
      expect((await correct('hr', 'joseph', WED, { checkIn: `${WED}T09:00`, checkOut: `${WED}T17:00`, dayVersion: 1, reason: '' })).body.fields).toEqual({ reason: 'Say why, in a few words.' });
      expect((await correct('hr', 'joseph', '2026-12-20', { override: 'present' })).status).toBe(409);
      expect((await correct('hr', 'joseph', '2026-11-20', { override: 'present' })).status).toBe(409);
      expect((await correct('hr', 'joseph', WED, { checkIn: `${WED}T09:00`, checkOut: `${WED}T17:00`, dayVersion: 1, breaks: [] })).status).toBe(400);
      expect((await docOf('joseph', WED)).version).toBe(1);
    });

    it('can take a mistaken punch away, and what was there stays in the history', async () => {
      const answer = await correct('admin', 'joseph', WED, { dayVersion: 1, reason: 'Entered on the wrong person' });
      expect(answer.body.day).toMatchObject({ status: 'absent', checkInAt: null });
      const doc = await docOf('joseph', WED);
      expect(doc.history[1]).toMatchObject({ byName: 'Anita Menon', before: { checkInAt: moment(WED, '09:00'), checkOutAt: moment(WED, '18:00') }, after: { checkInAt: null, checkOutAt: null } });
    });

    it('are for HR and Admin, and never on their own record', async () => {
      for (const viewer of ['manager', 'employee']) expect((await correct(viewer, 'employee', WED, { override: 'half_day', dayVersion: 3 })).status, viewer).toBe(403);
      const own = await correct('hr', 'hr', MON, { checkIn: `${MON}T09:00`, checkOut: `${MON}T18:00`, dayVersion: 2 });
      expect([own.status, own.body.error]).toEqual([403, OWN_RECORD_MESSAGE]);
      expect((await dayAs('hr', 'hr', MON)).body.editable).toBe(false);
      // Another HR or Admin may: the Admin corrects HR's day.
      expect((await correct('admin', 'hr', MON, { checkIn: `${MON}T09:00`, checkOut: `${MON}T18:00`, dayVersion: 2 })).status).toBe(200);
      const hr = await person('hr');
      const body = { checkIn: null, checkOut: null, override: 'present', lateExcused: false, reason: 'Confirmed with the client', dayVersion: 0 };
      expect((await hr.post(`/attendance/days/not-an-id/${MON}/correct`, body)).status).toBe(400);
      expect((await hr.post(`/attendance/days/${await idByKey('employee')}/yesterday/correct`, body)).status).toBe(400);
      expect((await hr.post(`/attendance/days/emp_000000000000/${MON}/correct`, body)).status).toBe(404);
    });
  });

  describe('HR’s note on a day', () => {
    const note = async (viewer: string, key: string, date: string, text: string) => (await person(viewer)).put<DayDetailPayload & ErrorPayload>(`/attendance/days/${await idByKey(key)}/${date}/note`, { text });

    it('is shown to the person and their managers, and does not stand in the way of a check-in', async () => {
      // Monday the 14th, before work. Arjun has not checked in yet.
      const NEXT = day(7);
      setNow(NEXT, '08:00');
      const left = await note('hr', 'employee', NEXT, '  Working from the Kochi office today ');
      expect(left.status).toBe(200);
      expect(left.body.record).toMatchObject({ checkInAt: null, note: { text: 'Working from the Kochi office today', byName: 'Rahul Nair', at: moment(NEXT, '08:00') } });
      expect(left.body.day.status).toBe('not_due');

      for (const viewer of ['employee', 'manager', 'admin']) expect((await dayAs(viewer, 'employee', NEXT)).body.record?.note?.text, viewer).toBe('Working from the Kochi office today');
      expect((await dayAs('nisha', 'employee', NEXT)).status).toBe(404);

      setNow(NEXT, '09:00');
      expect((await punch('employee', 'check-in')).day.status).toBe('working');
      expect((await docOf('employee', NEXT)).history.map((h) => h.kind)).toEqual(['note', 'check_in']);
    });

    it('can be changed and removed, each kept in the day’s history', async () => {
      const NEXT = day(7);
      expect((await note('hr', 'employee', NEXT, 'Working from the Kochi office today')).body.fields).toEqual({ text: 'The note already says that.' });
      expect((await note('admin', 'employee', NEXT, 'Kochi office, back on Tuesday')).body.record?.note).toMatchObject({ text: 'Kochi office, back on Tuesday', byName: 'Anita Menon' });
      expect((await note('hr', 'employee', NEXT, '')).body.record?.note).toBeNull();
      expect((await note('hr', 'employee', NEXT, ' ')).body.fields).toEqual({ text: 'There is no note to remove.' });
      expect((await note('hr', 'employee', NEXT, 'x'.repeat(501))).status).toBe(422);

      const doc = await docOf('employee', NEXT);
      expect(doc.history.filter((h) => h.kind === 'note').map((h) => [h.before, h.after])).toEqual([
        [{ note: null }, { note: 'Working from the Kochi office today' }],
        [{ note: 'Working from the Kochi office today' }, { note: 'Kochi office, back on Tuesday' }],
        [{ note: 'Kochi office, back on Tuesday' }, { note: null }],
      ]);
      // The punch is untouched by any of it.
      expect(doc.checkInAt).toBe(moment(NEXT, '09:00'));
      expect((await auditOf('attendance.note.set')).map((row) => row.actor?.name)).toEqual(['Rahul Nair', 'Anita Menon']);
      expect(await auditOf('attendance.note.removed')).toHaveLength(1);
    });

    it('is for HR and Admin, and never on their own record', async () => {
      const NEXT = day(7);
      for (const viewer of ['manager', 'employee']) expect((await note(viewer, 'employee', NEXT, 'Hello')).status, viewer).toBe(403);
      const own = await note('hr', 'hr', NEXT, 'Left early');
      expect([own.status, own.body.error]).toEqual([403, OWN_RECORD_MESSAGE]);
      expect((await note('hr', 'employee', '2026-12-25', 'Christmas')).status).toBe(409);
    });
  });

  describe('where requests show', () => {
    it('on the calendar and the home page: waiting, and corrected', async () => {
      const NEXT = day(7);
      setNow(NEXT, '10:00');
      // Arjun was not in on Saturday the 12th, and asks for it to count.
      const request = await asked('employee', day(5), 'absent_correction', { status: 'present', reason: 'Trade fair stand all day' });
      const arjun = await person('employee');
      const month = (await arjun.get<AttendanceCalendarPayload>('/attendance/calendar?month=2026-12')).body;
      const flagsOn = (date: string) => month.days.find((d) => d.date === date)!.flags;
      expect(flagsOn(day(5))).toEqual(['pending_correction']);
      // Monday (three approved requests), Wednesday (one) and Friday (HR's own edit) are marked as corrected.
      for (const date of [MON, WED, FRI]) expect(flagsOn(date), date).toEqual(['corrected']);
      expect(month.summary.correctedDays).toBe(3);

      const home = (await arjun.get<MyDashboardPayload>('/dashboard/me')).body;
      expect(home.corrections.map((c) => [c.id, c.date, c.status])).toEqual([[request.id, day(5), 'pending']]);
      expect(home.recent.find((d) => d.date === day(5))?.flags).toEqual(['pending_correction']);
      // Kiran, with no schedule, has nothing to correct and is told why.
      const kiran = await ask('kiran', MON, 'absent_correction', { status: 'present' });
      expect([kiran.status, kiran.body.error]).toEqual([409, 'You have no work schedule yet, so there is no attendance to correct.']);
    });

    it('in each person’s own list, and in the list of what their approver has decided', async () => {
      const mine = (await (await person('employee')).get<CorrectionListPayload>('/regularizations')).body;
      // Newest first: Saturday's, still waiting; Friday's, rejected; then the four that were approved.
      expect(mine).toMatchObject({ view: 'mine', page: 1, total: 6 });
      expect(mine.items.map((item) => item.status)).toEqual(['pending', 'rejected', 'approved', 'approved', 'approved', 'approved']);
      expect(mine.items[0]).toMatchObject({ date: day(5), status: 'pending', employeeName: 'Arjun Das', timeZone: ZONE });
      expect(new Set(mine.items.map((item) => item.employeeId))).toEqual(new Set([await idByKey('employee')]));

      // Fatima's side: Arjun's waiting request in her inbox, and what has been decided for her people.
      expect((await inboxOf('manager')).map((item) => [item.employeeName, item.date])).toEqual([['Arjun Das', day(5)]]);
      expect((await (await person('manager')).get<MePayload>('/me')).body.approvalsWaiting).toBe(1);
      const decided = (await (await person('manager')).get<CorrectionListPayload>('/regularizations?view=decided')).body;
      expect(decided.items.every((item) => item.status !== 'pending')).toBe(true);
      expect(new Set(decided.items.map((item) => item.employeeName))).toEqual(new Set(['Arjun Das', 'Divya Thomas', 'Imran Sheikh']));
      // An employee decides nothing and is waiting on nothing.
      expect((await (await person('employee')).get<MePayload>('/me')).body.approvalsWaiting).toBe(0);
      expect((await (await person('employee')).get('/regularizations?view=everything')).status).toBe(400);
      expect((await new Client().get('/regularizations')).status).toBe(401);
    });
  });
});
