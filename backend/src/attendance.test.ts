/*
 * End-to-end tests of check-in, check-out and breaks (Phase 3) against a real MongoDB. The
 * tests set the server's clock and walk several people through a week. What a day means is
 * tested exhaustively in shared/src/attendance.test.ts; here it is the API: one document per
 * person per day, the server's time and nobody else's, and who may read what.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exampleA, exampleB, zonedToInstant, type AssignmentResult, type DayDetailPayload, type ErrorPayload, type Schedule, type TodayPayload } from '@delta-hrms/shared';
import { as, boot, type Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

const ZONE = 'Asia/Kolkata';
const MON = '2026-12-07';
const TUE = '2026-12-08';
const WED = '2026-12-09';
const THU = '2026-12-10';
const FRI = '2026-12-11';
const SAT = '2026-12-12';

/** The moment the wall clock in a zone shows a time on a day. */
const moment = (date: string, time: string, zone = ZONE) => new Date(zonedToInstant(date, time.slice(0, 5), zone).getTime() + Number(time.slice(6) || 0) * 1000).toISOString();
/** Sets the server's clock. */
const setNow = (date: string, time: string, zone = ZONE) => mod.clock.setTestNow(moment(date, time, zone));

beforeAll(async () => {
  await boot('attendance');
  if (!reachable) return;
  // The sample company is created early on Monday morning: everyone's schedule starts that day.
  setNow(MON, '05:00');
  await resetToSample();
});
afterAll(shutdown);

const emailByKey = (key: string) => mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.email;
const idByKey = (key: string) => idOf(emailByKey(key));

/** One signed-in client per person, reused across the tests. */
const clients = new Map<string, Client>();
async function person(key: string) {
  let client = clients.get(key);
  if (!client) {
    client = await signIn(emailByKey(key));
    clients.set(key, client);
  }
  return client;
}

const today = async (client: Client) => (await client.get<TodayPayload>('/attendance/today')).body;
const punch = (client: Client, action: 'check-in' | 'check-out' | 'break/start' | 'break/end', body?: unknown) => client.post<TodayPayload & ErrorPayload>(`/attendance/${action}`, body);
const dayOf = async (client: Client, employeeId: string, date: string) => client.get<DayDetailPayload & ErrorPayload>(`/attendance/days/${employeeId}/${date}`);
const docOf = async (key: string, date: string) => mod.db().attendanceDays.findOne({ _id: `${await idByKey(key)}|${date}` });

describe.skipIf(!reachable)('attendance', () => {
  describe('a normal day', () => {
    it('checks in and out on the server’s clock, and reads the day from the facts', async () => {
      const arjun = await person('employee');
      setNow(MON, '08:55');
      const before = await today(arjun);
      expect(before).toMatchObject({ today: MON, timeZone: ZONE, openFromEarlier: false, checkInBlocked: null, can: { checkIn: true, checkOut: false, startBreak: false, endBreak: false } });
      expect(before.day).toMatchObject({ date: MON, kind: 'working', status: 'not_due', checkInAt: null });
      expect(before.rules?.name).toBe('General 9 to 6');
      expect(before.serverNow).toBe(moment(MON, '08:55'));

      const inAnswer = await punch(arjun, 'check-in');
      expect(inAnswer.status).toBe(200);
      expect(inAnswer.body.day).toMatchObject({ status: 'working', checkInAt: moment(MON, '08:55'), checkOutAt: null, flags: [], closableUntil: moment(TUE, '00:55') });
      expect(inAnswer.body.can).toEqual({ checkIn: false, checkOut: true, startBreak: false, endBreak: false });

      setNow(MON, '13:00');
      expect((await today(arjun)).day).toMatchObject({ status: 'working', grossMinutes: 245, workedMinutes: 245 });

      setNow(MON, '18:05');
      const outAnswer = await punch(arjun, 'check-out');
      expect(outAnswer.status).toBe(200);
      expect(outAnswer.body.day).toMatchObject({ status: 'present', checkOutAt: moment(MON, '18:05'), grossMinutes: 550, breakMinutes: 60, workedMinutes: 490, flags: [], units: { worked: 1, leave: 0, absent: 0, unresolved: 0 } });
      expect(outAnswer.body.can).toEqual({ checkIn: false, checkOut: false, startBreak: false, endBreak: false });
      expect(outAnswer.body.checkInBlocked).toMatch(/already checked in for today/);
    });

    it('stores one document for the day, holding facts and their history and no verdict', async () => {
      const doc = (await docOf('employee', MON))!;
      const assignment = (await mod.db().scheduleAssignments.findOne({ employeeId: await idByKey('employee') }))!;
      expect(doc).toMatchObject({ employeeId: await idByKey('employee'), date: MON, assignmentId: assignment._id, checkInAt: moment(MON, '08:55'), checkOutAt: moment(MON, '18:05'), breaks: [], override: null, lateExcused: false, version: 2 });
      expect(doc.history.map((h) => [h.kind, h.at, h.byName])).toEqual([
        ['check_in', moment(MON, '08:55'), 'Arjun Das'],
        ['check_out', moment(MON, '18:05'), 'Arjun Das'],
      ]);
      // Nothing that is a judgement is stored: it is worked out when asked for.
      for (const field of ['status', 'result', 'flags', 'units', 'workedMinutes', 'late']) expect(doc).not.toHaveProperty(field);
      expect(await mod.db().attendanceDays.countDocuments({ employeeId: await idByKey('employee') })).toBe(1);
    });
  });

  describe('the time is the server’s', () => {
    it('refuses a punch that carries anything: a time, a date, another person', async () => {
      const rahul = await person('hr');
      setNow(MON, '09:00');
      for (const body of [{ at: '2026-12-07T02:00:00.000Z' }, { checkInAt: moment(MON, '08:00') }, { date: '2026-12-01' }, { employeeId: await idByKey('employee') }, { time: '09:00' }, { late: false }]) {
        const answer = await punch(rahul, 'check-in', body);
        expect(answer.status, JSON.stringify(body)).toBe(400);
      }
      expect(await docOf('hr', MON)).toBeNull();
      // With nothing in it, it goes through, at the server's 09:00.
      expect((await punch(rahul, 'check-in', {})).body.day.checkInAt).toBe(moment(MON, '09:00'));
      expect((await punch(rahul, 'check-out', { checkOutAt: moment(MON, '23:00') })).status).toBe(400);
      expect((await docOf('hr', MON))!.checkOutAt).toBeNull();
    });
  });

  describe('one check-in per day', () => {
    it('refuses a second check-in', async () => {
      const arjun = await person('employee');
      setNow(MON, '18:30');
      const again = await punch(arjun, 'check-in');
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/already checked in for today/);
      expect((await docOf('employee', MON))!.version).toBe(2);
    });

    it('stores one when five arrive at the same instant', async () => {
      const divya = await person('divya');
      setNow(MON, '10:00');
      const results = await Promise.all(Array.from({ length: 5 }, () => punch(divya, 'check-in')));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const doc = (await docOf('divya', MON))!;
      expect(doc.history.filter((h) => h.kind === 'check_in')).toHaveLength(1);
      expect(doc.version).toBe(1);
      expect(await mod.db().attendanceDays.countDocuments({ employeeId: await idByKey('divya') })).toBe(1);
    });

    it('still takes the check-in on a day that already has a note on it', async () => {
      const id = await idByKey('joseph');
      const noteAt = moment(MON, '08:30');
      // A day document without a punch, as HR's note leaves one (Phase 6).
      await mod.db().attendanceDays.insertOne({ _id: `${id}|${MON}`, employeeId: id, date: MON, assignmentId: null, checkInAt: null, checkOutAt: null, breaks: [], override: null, lateExcused: false, note: { text: 'Client visit in the afternoon', by: 'emp_hr', byName: 'Rahul Nair', at: noteAt }, history: [{ at: noteAt, by: 'emp_hr', byName: 'Rahul Nair', kind: 'note' }], version: 1, createdAt: noteAt, updatedAt: noteAt });
      const joseph = await person('joseph');
      setNow(MON, '08:45');
      expect((await today(joseph)).can.checkIn).toBe(true);
      // 09:10:59 is still inside the ten minutes of grace: the clock shows 09:10.
      setNow(MON, '09:10:59');
      const answer = await punch(joseph, 'check-in');
      expect(answer.status).toBe(200);
      expect(answer.body.day).toMatchObject({ status: 'working', flags: [], lateMinutes: 0 });
      const doc = (await docOf('joseph', MON))!;
      expect(doc.note?.text).toBe('Client visit in the afternoon');
      expect(doc.history.map((h) => h.kind)).toEqual(['note', 'check_in']);
      expect(doc.assignmentId).not.toBeNull();
      expect((await punch(joseph, 'check-in')).status).toBe(409);
    });

    it('marks a check-in one minute past the grace as late, counted from the start time', async () => {
      const anita = await person('admin');
      setNow(MON, '09:11');
      const answer = await punch(anita, 'check-in');
      expect(answer.body.day).toMatchObject({ status: 'working', flags: ['late'], lateMinutes: 11 });
    });
  });

  describe('checking out', () => {
    it('needs a check-in, and happens once', async () => {
      const fatima = await person('manager');
      setNow(MON, '09:00');
      const none = await punch(fatima, 'check-out');
      expect(none.status).toBe(409);
      expect(none.body.error).toBe('You are not checked in.');
      expect((await punch(fatima, 'check-in')).status).toBe(200);
      setNow(MON, '17:00');
      // Eight hours less the hour's break is seven worked: under the 7 h 30 a full day needs.
      expect((await punch(fatima, 'check-out')).body.day).toMatchObject({ status: 'half_day', flags: ['early_departure', 'short_hours'], earlyMinutes: 60, workedMinutes: 420, units: { worked: 0.5, leave: 0, absent: 0.5, unresolved: 0 } });
      const again = await punch(fatima, 'check-out');
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/already checked out/);
      expect((await docOf('manager', MON))!.checkOutAt).toBe(moment(MON, '17:00'));
    });

    it('stores one check-out when three arrive at the same instant', async () => {
      const nisha = await person('nisha');
      setNow(MON, '09:00');
      await punch(nisha, 'check-in');
      setNow(MON, '18:00');
      const results = await Promise.all([punch(nisha, 'check-out'), punch(nisha, 'check-out'), punch(nisha, 'check-out')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      const doc = (await docOf('nisha', MON))!;
      expect(doc.history.map((h) => h.kind)).toEqual(['check_in', 'check_out']);
      expect(doc.version).toBe(2);
    });
  });

  describe('someone with no schedule', () => {
    it('cannot check in, and is told why', async () => {
      const kiran = await person('kiran');
      setNow(MON, '09:00');
      const state = await today(kiran);
      expect(state).toMatchObject({ rules: null, can: { checkIn: false, checkOut: false }, day: { status: 'not_applicable', kind: null } });
      expect(state.checkInBlocked).toMatch(/no work schedule yet/);
      const answer = await punch(kiran, 'check-in');
      expect(answer.status).toBe(409);
      expect(answer.body.error).toMatch(/no work schedule yet/);
      expect(await docOf('kiran', MON)).toBeNull();
    });

    it('can from the day their schedule starts, not before', async () => {
      const kiran = await person('kiran');
      const hr = await as('HR');
      const a = (await mod.db().schedules.findOne({ name: 'General 9 to 6' }))!._id;
      setNow(MON, '10:00');
      const given = await hr.post<AssignmentResult>('/schedule-assignments', { employeeIds: [await idByKey('kiran')], scheduleId: a, rules: null, effectiveFrom: TUE, note: '' });
      expect(given.body.assigned).toHaveLength(1);
      expect((await punch(kiran, 'check-in')).status).toBe(409);
      // Tuesday, 08:00: the schedule has started and the day is open.
      setNow(TUE, '08:00');
      expect((await punch(kiran, 'check-in')).body.day).toMatchObject({ date: TUE, status: 'working' });
      // Monday does not exist for them: it was before their first schedule.
      const monday = await dayOf(kiran, await idByKey('kiran'), MON);
      expect(monday.body.day).toMatchObject({ status: 'not_applicable', units: null });
      setNow(TUE, '17:30');
      await punch(kiran, 'check-out');
    });
  });

  describe('breaks', () => {
    it('are recorded where the schedule records them, one at a time', async () => {
      const sneha = await person('sneha');
      setNow(MON, '11:00');
      expect((await punch(sneha, 'break/start')).status).toBe(409);
      setNow(MON, '11:20');
      const checkedIn = await punch(sneha, 'check-in');
      // Flexible hours: no start time, so no lateness.
      expect(checkedIn.body.day).toMatchObject({ status: 'working', flags: [], shiftStartAt: null });
      expect(checkedIn.body.can).toEqual({ checkIn: false, checkOut: true, startBreak: true, endBreak: false });

      setNow(MON, '13:00');
      const started = await punch(sneha, 'break/start');
      expect(started.body.day).toMatchObject({ status: 'on_break', onBreakSince: moment(MON, '13:00') });
      expect(started.body.can).toEqual({ checkIn: false, checkOut: true, startBreak: false, endBreak: true });
      expect((await punch(sneha, 'break/start')).status).toBe(409);
      // Three at once still make one break.
      setNow(MON, '13:45');
      const ends = await Promise.all([punch(sneha, 'break/end'), punch(sneha, 'break/end'), punch(sneha, 'break/end')]);
      expect(ends.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect((await today(sneha)).day).toMatchObject({ status: 'working', onBreakSince: null, breakMinutes: 45 });
      const notOn = await punch(sneha, 'break/end');
      expect(notOn.status).toBe(409);
      expect(notOn.body.error).toBe('You are not on a break.');
    });

    it('end with the check-out when one is still running', async () => {
      const sneha = await person('sneha');
      setNow(MON, '19:50');
      await punch(sneha, 'break/start');
      setNow(MON, '20:05');
      const out = await punch(sneha, 'check-out');
      // 8 h 45 from 11:20 to 20:05, less 45 and 15 minutes of breaks.
      expect(out.body.day).toMatchObject({ status: 'half_day', grossMinutes: 525, breakMinutes: 60, workedMinutes: 465, onBreakSince: null });
      const doc = (await docOf('sneha', MON))!;
      expect(doc.breaks).toEqual([
        { startAt: moment(MON, '13:00'), endAt: moment(MON, '13:45') },
        { startAt: moment(MON, '19:50'), endAt: moment(MON, '20:05') },
      ]);
      expect(doc.history.map((h) => h.kind)).toEqual(['check_in', 'break_start', 'break_end', 'break_start', 'check_out']);
      expect((await punch(sneha, 'break/start')).status).toBe(409);
    });

    it('are not for a schedule with a fixed break', async () => {
      const vivek = await person('lead');
      setNow(MON, '10:00');
      await punch(vivek, 'check-in');
      const answer = await punch(vivek, 'break/start');
      expect(answer.status).toBe(409);
      expect(answer.body.error).toMatch(/not recorded on your schedule/);
      expect((await today(vivek)).can.startBreak).toBe(false);
      setNow(MON, '19:00');
      await punch(vivek, 'check-out');
    });
  });

  describe('a forgotten check-out', () => {
    it('can be closed until the next working day opens, and not a minute after', async () => {
      // Imran checks in late, at 17:30 on Monday, and forgets. Sixteen hours would run to 09:30 on
      // Tuesday, but his Tuesday opens for check-in at 07:00 (three hours before a 10:00 start).
      const imran = await person('imran');
      setNow(MON, '17:30');
      await punch(imran, 'check-in');
      setNow(TUE, '06:59');
      expect(await today(imran)).toMatchObject({ openFromEarlier: true, can: { checkIn: false, checkOut: true }, day: { date: MON, status: 'working', closableUntil: moment(TUE, '07:00') } });
      setNow(TUE, '07:00');
      expect(await today(imran)).toMatchObject({ openFromEarlier: false, can: { checkIn: true, checkOut: false }, day: { date: TUE, status: 'not_due' } });
      const tooLate = await punch(imran, 'check-out');
      expect(tooLate.status).toBe(409);
      expect(tooLate.body.error).toMatch(/can no longer be checked out/);
      expect((await docOf('imran', MON))!.checkOutAt).toBeNull();
    });

    it('does not stop the next day, and reads as unresolved until it is corrected', async () => {
      // Divya checked in at 10:00 on Monday and never checked out. Sixteen hours ran out at 02:00.
      const divya = await person('divya');
      const id = await idByKey('divya');
      setNow(TUE, '01:59');
      expect(await today(divya)).toMatchObject({ openFromEarlier: true, can: { checkOut: true }, day: { date: MON } });
      setNow(TUE, '09:00');
      const state = await today(divya);
      expect(state).toMatchObject({ openFromEarlier: false, can: { checkIn: true, checkOut: false }, day: { date: TUE, status: 'not_due' } });
      const tooLate = await punch(divya, 'check-out');
      expect(tooLate.status).toBe(409);
      expect(tooLate.body.error).toMatch(/can no longer be checked out/);
      expect((await docOf('divya', MON))!.checkOutAt).toBeNull();

      const monday = (await dayOf(divya, id, MON)).body;
      expect(monday.day).toMatchObject({ status: 'unresolved', units: { worked: 0, leave: 0, absent: 0, unresolved: 1 }, workedMinutes: 0 });
      expect(monday.day.flags).toContain('missing_check_out');

      setNow(TUE, '10:00');
      expect((await punch(divya, 'check-in')).body.day).toMatchObject({ date: TUE, status: 'working' });
      expect(await mod.db().attendanceDays.countDocuments({ employeeId: id })).toBe(2);
      setNow(TUE, '19:00');
      await punch(divya, 'check-out');
    });

    it('says so on the home page when the open day began on an earlier date, and can still be closed in time', async () => {
      const arjun = await person('employee');
      setNow(TUE, '09:00');
      await punch(arjun, 'check-in');
      // Half past midnight: Tuesday can be closed until 01:00, and Wednesday has not opened.
      setNow(WED, '00:30');
      const state = await today(arjun);
      expect(state).toMatchObject({ today: WED, openFromEarlier: true, can: { checkIn: false, checkOut: true }, day: { date: TUE, status: 'working' } });
      const blocked = await punch(arjun, 'check-in');
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('You are still checked in since 09:00 on Tuesday 8 December. Check out first.');
      const out = await punch(arjun, 'check-out');
      expect(out.body.day).toMatchObject({ date: TUE, status: 'present', grossMinutes: 930, workedMinutes: 870, checkOutAt: moment(WED, '00:30') });
      expect((await docOf('employee', TUE))!.checkOutAt).toBe(moment(WED, '00:30'));
      expect(await docOf('employee', WED)).toBeNull();
    });
  });

  describe('each person by their own rules', () => {
    it('judges A, B and C differently at the same moment', async () => {
      const [rahul, vivek, sneha] = [await person('hr'), await person('lead'), await person('sneha')];
      setNow(TUE, '10:03');
      const [a, b, c] = [(await punch(rahul, 'check-in')).body.day, (await punch(vivek, 'check-in')).body.day, (await punch(sneha, 'check-in')).body.day];
      expect([a.flags, a.lateMinutes]).toEqual([['late'], 63]);
      expect([b.flags, b.lateMinutes]).toEqual([[], 0]);
      expect([c.flags, c.lateMinutes]).toEqual([[], 0]);
      expect([a.shiftStartAt, b.shiftStartAt, c.shiftStartAt]).toEqual([moment(TUE, '09:00'), moment(TUE, '10:00'), null]);
      setNow(TUE, '19:10');
      const [aOut, bOut, cOut] = [(await punch(rahul, 'check-out')).body.day, (await punch(vivek, 'check-out')).body.day, (await punch(sneha, 'check-out')).body.day];
      // Nine hours seven: an hour's break off for A and B, none recorded for C.
      expect([aOut.workedMinutes, bOut.workedMinutes, cOut.workedMinutes]).toEqual([487, 487, 547]);
      expect([aOut.status, bOut.status, cOut.status]).toEqual(['present', 'present', 'present']);
    });

    it('calls a working day absent only once it is over', async () => {
      // Joseph does not come in on Wednesday.
      const joseph = await person('joseph');
      const id = await idByKey('joseph');
      setNow(WED, '09:05');
      expect((await today(joseph)).day).toMatchObject({ date: WED, status: 'not_due', units: null });
      setNow(WED, '09:11');
      expect((await today(joseph)).day.status).toBe('not_in');
      setNow(WED, '17:59');
      expect((await dayOf(joseph, id, WED)).body.day).toMatchObject({ status: 'not_in', units: null });
      setNow(WED, '18:00');
      expect((await dayOf(joseph, id, WED)).body.day).toMatchObject({ status: 'absent', units: { worked: 0, leave: 0, absent: 1, unresolved: 0 } });
      expect((await dayOf(joseph, id, WED)).body.record).toBeNull();
      // His Monday check-in was never closed either: that reads as unresolved, not as absent.
      expect((await dayOf(joseph, id, MON)).body.day.status).toBe('unresolved');
    });
  });

  describe('who may read a day', () => {
    it('is the person, their managers, and HR. Anyone else is told there is nobody', async () => {
      setNow(WED, '12:00');
      const arjunId = await idByKey('employee');
      const own = await dayOf(await person('employee'), arjunId, MON);
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ scheduleName: 'General 9 to 6', timeZone: ZONE, day: { status: 'present' }, record: { checkInAt: moment(MON, '08:55'), version: 2 } });
      // Where each request came from is kept for the audit, and not handed out.
      for (const h of own.body.record!.history) {
        expect(h).not.toHaveProperty('ip');
        expect(h).not.toHaveProperty('userAgent');
      }
      expect((await mod.db().attendanceDays.findOne({ _id: `${arjunId}|${MON}` }))!.history[0]).toHaveProperty('ip');

      const other = await dayOf(await person('employee'), await idByKey('divya'), MON);
      const nobody = await dayOf(await person('employee'), 'emp_000000000000', MON);
      expect(other.status).toBe(404);
      expect(other.body).toEqual(nobody.body);

      const manager = await person('manager');
      expect((await dayOf(manager, arjunId, MON)).status).toBe(200);
      expect((await dayOf(manager, await idByKey('divya'), MON)).status, 'a report of a report').toBe(200);
      expect((await dayOf(manager, await idByKey('joseph'), MON)).status, 'another team').toBe(404);
      expect((await dayOf(await as('HR'), await idByKey('joseph'), MON)).status).toBe(200);
      expect((await dayOf(await person('employee'), arjunId, '2026-02-30')).status).toBe(400);
      expect((await dayOf(await person('employee'), 'not-an-id', MON)).status).toBe(400);
    });

    it('reads days with nothing recorded too: a day off, and the time before their schedule', async () => {
      const arjun = await person('employee');
      const id = await idByKey('employee');
      setNow(SAT, '20:00');
      expect((await dayOf(arjun, id, '2026-12-06')).body.day).toMatchObject({ status: 'not_applicable', kind: null });
      // A day off reads as a day off, also when it is still to come. A working day to come is "upcoming".
      expect((await dayOf(arjun, id, '2026-12-13')).body.day).toMatchObject({ status: 'weekly_off', kind: 'weekly_off', units: null });
      expect((await dayOf(arjun, id, '2026-12-14')).body.day).toMatchObject({ status: 'upcoming', kind: 'working', units: null });
    });
  });

  describe('a change of schedule', () => {
    it('leaves every earlier day reading exactly as it did', async () => {
      const hr = await as('HR');
      const [arjunId, josephId] = [await idByKey('employee'), await idByKey('joseph')];
      const days: [string, string][] = [
        [arjunId, MON],
        [arjunId, TUE],
        [arjunId, WED],
        [josephId, MON],
        [josephId, TUE],
        [josephId, WED],
      ];
      const read = async () => Promise.all(days.map(async ([id, date]) => (await dayOf(hr, id, date)).body));
      // Wednesday evening: all six days are over.
      setNow(WED, '20:00');
      const before = await read();
      expect(before.map((d) => d.day.status)).toEqual(['present', 'present', 'absent', 'unresolved', 'absent', 'absent']);

      // From Thursday both are on the late shift: other hours, another weekly off, another grace.
      const b = (await mod.db().schedules.findOne({ name: 'Late shift 10 to 7' }))!._id;
      const given = await hr.post<AssignmentResult>('/schedule-assignments', { employeeIds: [arjunId, josephId], scheduleId: b, rules: null, effectiveFrom: THU, note: '' });
      expect(given.body.assigned).toHaveLength(2);
      expect(await read()).toEqual(before);

      // Saturday: the new rules have been in force for two days. The earlier days have not moved.
      setNow(SAT, '12:00');
      expect(await read()).toEqual(before);
      // The new days are judged by the new rules: Friday is now their weekly off.
      expect((await dayOf(hr, arjunId, FRI)).body).toMatchObject({ scheduleName: 'Late shift 10 to 7', day: { status: 'weekly_off' } });
      expect((await dayOf(hr, arjunId, THU)).body.day).toMatchObject({ status: 'absent', shiftStartAt: moment(THU, '10:00') });
      // And the standard schedule itself can be changed without touching a single day.
      const a = (await mod.db().schedules.findOne({ name: 'General 9 to 6' }))!;
      expect((await hr.patch(`/schedules/${a._id}`, { rules: { ...exampleA(ZONE), lateGraceMinutes: 0, standard: { ...exampleA(ZONE).standard, start: '08:00', end: '17:00' } } })).status).toBe(200);
      expect(await read()).toEqual(before);
    });
  });

  describe('days off', () => {
    it('can be worked when the schedule allows it, and stay days off', async () => {
      // Friday is the weekly off on the late shift.
      const divya = await person('divya');
      setNow(FRI, '10:00');
      const state = await today(divya);
      expect(state).toMatchObject({ can: { checkIn: true }, day: { date: FRI, kind: 'weekly_off', status: 'weekly_off' } });
      const inAnswer = await punch(divya, 'check-in');
      expect(inAnswer.body.day).toMatchObject({ kind: 'weekly_off', status: 'working', flags: ['worked_on_off_day'] });
      setNow(FRI, '13:00');
      const out = await punch(divya, 'check-out');
      expect(out.body.day).toMatchObject({ kind: 'weekly_off', status: 'weekly_off', workedMinutes: 180, units: null, flags: ['worked_on_off_day'] });
    });

    it('cannot be worked when the schedule does not allow it', async () => {
      const admin = await as('Admin');
      const imranId = await idByKey('imran');
      setNow(WED, '12:00');
      const given = await admin.post<AssignmentResult>('/schedule-assignments', { employeeIds: [imranId], scheduleId: null, rules: { ...exampleB(ZONE), name: 'Late shift, no off-day work', offDayWork: 'blocked' }, effectiveFrom: THU, note: '' });
      expect(given.body.assigned).toHaveLength(1);
      const imran = await person('imran');
      setNow(FRI, '10:00');
      expect((await today(imran)).checkInBlocked).toBe('Today is your weekly off, and your schedule does not allow checking in on a day off.');
      const answer = await punch(imran, 'check-in');
      expect(answer.status).toBe(409);
      expect(await docOf('imran', FRI)).toBeNull();
    });
  });

  describe('time zones', () => {
    it('judges someone on a Dubai schedule by the clock in Dubai, wherever the server is', async () => {
      const admin = await as('Admin');
      setNow(SAT, '05:00');
      const dubai = (await admin.post<Schedule>('/schedules', { rules: { ...exampleA('Asia/Dubai'), name: 'Dubai office' } })).body;
      const made = await admin.post<{ employee: { id: string }; temporaryPassword: string }>('/employees', { name: 'Omar Haddad', email: 'omar.haddad@delta.test', phone: '', role: 'Employee', departmentId: null, designation: '', managerId: null, joinDate: null, schedule: { scheduleId: dubai.id, effectiveFrom: SAT } });
      expect(made.status).toBe(201);
      const omar = await signIn('omar.haddad@delta.test', made.body.temporaryPassword);
      expect((await omar.post('/me/password', { current: made.body.temporaryPassword, next: 'omar-own-password-1' })).status).toBe(204);

      // 09:05 in Dubai is 10:35 in India. For Omar it is five minutes past his start: on time.
      setNow(SAT, '09:05', 'Asia/Dubai');
      const inAnswer = await punch(omar, 'check-in');
      expect(inAnswer.body).toMatchObject({ today: SAT, timeZone: 'Asia/Dubai', day: { date: SAT, status: 'working', flags: [], checkInAt: '2026-12-12T05:05:00.000Z', shiftStartAt: '2026-12-12T05:00:00.000Z' } });
      // The same moment makes someone on India time an hour and a half late.
      const kiran = await person('kiran');
      expect((await punch(kiran, 'check-in')).body.day).toMatchObject({ lateMinutes: 95, flags: ['late'] });

      // 23:30 in Dubai is already Sunday in India. For Omar it is still Saturday, and his day is still open.
      setNow(SAT, '23:30', 'Asia/Dubai');
      expect(await today(omar)).toMatchObject({ today: SAT, openFromEarlier: false, day: { date: SAT, status: 'working' } });
      expect((await today(kiran)).today).toBe('2026-12-13');
      const out = await punch(omar, 'check-out');
      expect(out.body.day).toMatchObject({ date: SAT, status: 'present', grossMinutes: 865 });
    });
  });
});
