/*
 * End-to-end tests of work schedules (Phase 2) against a real MongoDB: standard schedules,
 * giving them to people from a date, and the promise that history never changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exampleA, OWN_RECORD_MESSAGE, type AssignmentInput, type AssignmentResult, type EmployeeSchedulePayload, type ErrorPayload, type MePayload, type Schedule, type ScheduleDetailPayload, type ScheduleRow, type ScheduleRules } from '@delta-hrms/shared';
import { as, boot, type Client, emailOf, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

/** Monday 7 December 2026, 09:30 in India. */
const NOW = '2026-12-07T04:00:00.000Z';
const TODAY = '2026-12-07';
const YESTERDAY = '2026-12-06';
const TOMORROW = '2026-12-08';
const NEXT_WEEK = '2026-12-14';
const ZONE = 'Asia/Kolkata';

beforeAll(async () => {
  await boot('schedules');
  if (!reachable) return;
  mod.clock.setTestNow(NOW);
  await resetToSample();
});
afterAll(shutdown);

const idByKey = async (key: string) => idOf(mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.email);
const scheduleId = async (name: string) => (await mod.db().schedules.findOne({ name }))!._id;
const scheduleOf = async (client: Client, employeeId: string) => (await client.get<EmployeeSchedulePayload>(`/employees/${employeeId}/schedule`)).body;
const assignment = (over: Partial<AssignmentInput>): AssignmentInput => ({ employeeIds: [], scheduleId: null, rules: null, effectiveFrom: TOMORROW, note: '', ...over });
const assign = async (client: Client, over: Partial<AssignmentInput>) => client.post<AssignmentResult>('/schedule-assignments', assignment(over));
const rules = (over: Partial<ScheduleRules> = {}): ScheduleRules => ({ ...exampleA(ZONE), name: 'Office hours', ...over });

describe.skipIf(!reachable)('work schedules', () => {
  describe('who may manage them', () => {
    it('is HR and Admin: everyone else is refused, to read and to change', async () => {
      const a = await scheduleId('General 9 to 6');
      const planned = (await mod.db().scheduleAssignments.findOne({ employeeId: await idByKey('newjoiner') }))!._id;
      for (const role of ['Employee', 'Manager'] as const) {
        const client = await as(role);
        expect((await client.get('/schedules')).status, `${role} list`).toBe(403);
        expect((await client.get(`/schedules/${a}`)).status, `${role} read`).toBe(403);
        expect((await client.post('/schedules', { rules: rules() })).status, `${role} create`).toBe(403);
        expect((await client.patch(`/schedules/${a}`, { rules: rules() })).status, `${role} change`).toBe(403);
        expect((await client.post(`/schedules/${a}/archive`, { archived: true })).status, `${role} archive`).toBe(403);
        expect((await assign(client, { employeeIds: [await idOf(emailOf.Employee)], scheduleId: a })).status, `${role} assign`).toBe(403);
        expect((await client.delete(`/schedule-assignments/${planned}`)).status, `${role} cancel`).toBe(403);
      }
      expect(await mod.db().schedules.countDocuments()).toBe(3);
      expect(await mod.db().scheduleAssignments.countDocuments({ _id: planned })).toBe(1);
    });
  });

  describe('standard schedules', () => {
    it('are listed with how many people are on each today', async () => {
      const { status, body } = await (await as('HR')).get<ScheduleRow[]>('/schedules');
      expect(status).toBe(200);
      // On A: Anita, Rahul, Fatima, Arjun, Joseph, Nisha. Not Meera (hers starts next week) and not Leela (she has left).
      expect(body.map((s) => [s.name, s.peopleCount])).toEqual([
        ['Flexible 8 hours', 1],
        ['General 9 to 6', 6],
        ['Late shift 10 to 7', 3],
      ]);
    });

    it('say who is on them, and since when', async () => {
      const { body } = await (await as('HR')).get<ScheduleDetailPayload>(`/schedules/${await scheduleId('Late shift 10 to 7')}`);
      expect(body.people.map((p) => [p.name, p.departmentName, p.effectiveFrom])).toEqual([
        ['Divya Thomas', 'Sales', TODAY],
        ['Imran Sheikh', 'Sales', TODAY],
        ['Vivek Sharma', 'Sales', TODAY],
      ]);
      expect((await (await as('HR')).get('/schedules/sch_000000000000')).status).toBe(404);
    });

    it('can be created, stored tidily, and never two with one name', async () => {
      const hr = await as('HR');
      const made = await hr.post<Schedule>('/schedules', { rules: rules({ name: '  Office hours  ' }) });
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ name: 'Office hours', archived: false, rules: { name: 'Office hours', lateGraceMinutes: 10 } });
      const again = await hr.post<ErrorPayload>('/schedules', { rules: rules({ name: 'OFFICE  hours' }) });
      expect(again.status).toBe(422);
      expect(again.body.fields).toHaveProperty(['rules.name']);
      // A flexible schedule is stored without the fields that mean nothing for it.
      const flexible = await hr.post<Schedule>('/schedules', { rules: rules({ name: 'Flexi days', kind: 'flexible', standard: { start: '09:00', end: '18:00', requiredMinutes: 480, fullDayMinutes: 480, halfDayMinutes: 240 }, break: { mode: 'none', minutes: 60, appliesAfter: 300 } }) });
      expect(flexible.status).toBe(201);
      expect(flexible.body.rules).toMatchObject({ standard: { start: null, end: null }, lateGraceMinutes: 0, earlyCheckInMinutes: 0, earlyLeave: { tracked: false }, break: { mode: 'none', minutes: 0 } });
      expect((await mod.db().audit.find({ action: 'schedule.created' }).sort({ $natural: 1 }).toArray()).map((a) => a.summary)).toEqual(['Created the schedule "Office hours".', 'Created the schedule "Flexi days".']);
    });

    it('are refused when the rules make no sense, naming each field', async () => {
      const hr = await as('HR');
      const refused = async (over: Partial<ScheduleRules>, field: string) => {
        const answer = await hr.post<ErrorPayload>('/schedules', { rules: rules({ name: 'Broken', ...over }) });
        expect(answer.status, field).toBe(422);
        expect(answer.body.fields, field).toHaveProperty([`rules.${field}`]);
      };
      await refused({ standard: { ...rules().standard, halfDayMinutes: 500 } }, 'standard.halfDayMinutes');
      await refused({ standard: { ...rules().standard, end: '09:00' } }, 'standard.end');
      await refused({ timeZone: 'India' }, 'timeZone');
      await refused({ missingCheckOut: { closeAfterMinutes: 120, countsAs: 'unresolved' } }, 'missingCheckOut.closeAfterMinutes');
      await refused({ days: { mon: 'off', tue: 'off', wed: 'off', thu: 'off', fri: 'off', sat: 'off', sun: 'off' } }, 'days');
      // The shape itself: an unknown field, a missing one, a wrong kind.
      expect((await hr.post('/schedules', { rules: { ...rules(), overtime: true } })).status).toBe(400);
      expect((await hr.post('/schedules', { rules: { ...rules(), kind: 'rotating' } })).status).toBe(400);
      const { break: _break, ...withoutBreak } = rules();
      expect((await hr.post('/schedules', { rules: withoutBreak })).status).toBe(400);
      expect(await mod.db().schedules.countDocuments({ name: 'Broken' })).toBe(0);
    });

    it('can be archived, and then given to nobody until restored', async () => {
      const hr = await as('HR');
      const office = await scheduleId('Office hours');
      expect((await hr.post<Schedule>(`/schedules/${office}/archive`, { archived: true })).body.archived).toBe(true);
      const refused = await assign(hr, { employeeIds: [await idByKey('kiran')], scheduleId: office });
      expect(refused.status).toBe(422);
      expect((await hr.post<Schedule>(`/schedules/${office}/archive`, { archived: false })).body.archived).toBe(false);
    });
  });

  describe('the brief’s three employees', () => {
    it('are each judged by their own rules', async () => {
      const hr = await as('HR');
      const a = (await scheduleOf(hr, await idOf(emailOf.Employee))).current!.rules;
      const b = (await scheduleOf(hr, await idByKey('divya'))).current!.rules;
      const c = (await scheduleOf(hr, await idByKey('sneha'))).current!.rules;
      expect(a).toMatchObject({ kind: 'fixed', standard: { start: '09:00', end: '18:00' }, lateGraceMinutes: 10, break: { mode: 'fixed', minutes: 60 }, days: { sun: 'off', fri: 'standard' } });
      expect(b).toMatchObject({ kind: 'fixed', standard: { start: '10:00', end: '19:00' }, lateGraceMinutes: 5, break: { mode: 'fixed', minutes: 60 }, days: { fri: 'off', sun: 'standard' } });
      expect(c).toMatchObject({ kind: 'flexible', standard: { start: null, requiredMinutes: 480 }, lateGraceMinutes: 0, days: { fri: { requiredMinutes: 240 }, sat: 'off', sun: 'off' } });
    });
  });

  describe('giving people a schedule', () => {
    it('never starts a change on a day that has begun, and never back-dates a first schedule', async () => {
      const hr = await as('HR');
      const a = await scheduleId('General 9 to 6');
      const b = await scheduleId('Late shift 10 to 7');
      const arjun = await idOf(emailOf.Employee);
      const kiran = await idByKey('kiran');

      // Arjun is on a schedule: a change today or earlier is refused, with the reason.
      for (const effectiveFrom of [TODAY, YESTERDAY, '2026-01-01']) {
        const { status, body } = await assign(hr, { employeeIds: [arjun], scheduleId: b, effectiveFrom });
        expect(status).toBe(200);
        expect(body.assigned).toEqual([]);
        expect(body.skipped[0]).toMatchObject({ employeeId: arjun, name: 'Arjun Das' });
        expect(body.skipped[0]!.reason).toMatch(/tomorrow at the earliest/);
      }
      expect((await scheduleOf(hr, arjun)).history).toHaveLength(1);

      // Kiran has none: yesterday is refused, today is fine, and attendance starts counting today.
      const early = await assign(hr, { employeeIds: [kiran], scheduleId: a, effectiveFrom: YESTERDAY });
      expect(early.body.skipped[0]!.reason).toMatch(/Nothing is back-dated/);
      expect((await mod.db().employees.findOne({ _id: kiran }))!.employment).toEqual([]);
      const first = await assign(hr, { employeeIds: [kiran], scheduleId: a, effectiveFrom: TODAY, note: 'Joined the support desk' });
      expect(first.body).toEqual({ assigned: [{ employeeId: kiran, name: 'Kiran Babu' }], skipped: [] });
      expect((await mod.db().employees.findOne({ _id: kiran }))!.employment).toEqual([{ from: TODAY, to: null }]);
      const schedule = await scheduleOf(hr, kiran);
      expect(schedule.current).toMatchObject({ effectiveFrom: TODAY, scheduleId: a, note: 'Joined the support desk', createdByName: 'Rahul Nair' });
      expect((await (await signIn('kiran.babu@delta.test')).get<MePayload>('/me')).body.scheduleName).toBe('General 9 to 6');
      expect((await hr.post('/schedule-assignments', assignment({ employeeIds: [kiran], scheduleId: a, effectiveFrom: 'next week' }))).status).toBe(400);
    });

    it('leaves the standard schedule and everyone’s copy apart: editing one changes nobody', async () => {
      const hr = await as('HR');
      const a = await scheduleId('General 9 to 6');
      const arjun = await idOf(emailOf.Employee);
      const before = await scheduleOf(hr, arjun);
      const assignmentsBefore = await mod.db().scheduleAssignments.find().sort({ _id: 1 }).toArray();

      const changed = await hr.patch<Schedule>(`/schedules/${a}`, { rules: { ...exampleA(ZONE), lateGraceMinutes: 30, standard: { ...exampleA(ZONE).standard, start: '09:30', end: '18:30' } } });
      expect(changed.status).toBe(200);
      expect(changed.body.rules).toMatchObject({ lateGraceMinutes: 30, standard: { start: '09:30' } });

      // Not one assignment moved: every person still has exactly the copy they were given.
      expect(await mod.db().scheduleAssignments.find().sort({ _id: 1 }).toArray()).toEqual(assignmentsBefore);
      const after = await scheduleOf(hr, arjun);
      expect(after).toEqual(before);
      expect(after.current!.rules).toMatchObject({ lateGraceMinutes: 10, standard: { start: '09:00' } });
      expect((await mod.db().audit.findOne({ action: 'schedule.updated' }))?.summary).toContain("Nobody's own schedule was changed");
    });

    it('applies an edited schedule to the people on it from a chosen date, and to nobody’s past', async () => {
      const hr = await as('HR');
      const a = await scheduleId('General 9 to 6');
      const onIt = (await hr.get<ScheduleDetailPayload>(`/schedules/${a}`)).body.people;
      const hrId = await idOf(emailOf.HR);
      expect(onIt.map((p) => p.id)).toContain(hrId);

      const { body } = await assign(hr, { employeeIds: onIt.map((p) => p.id), scheduleId: a, effectiveFrom: TOMORROW, note: 'New office hours' });
      // Everyone on it but the person doing it: their own schedule is someone else's to change.
      expect(body.skipped).toEqual([{ employeeId: hrId, name: 'Rahul Nair', reason: OWN_RECORD_MESSAGE }]);
      expect(body.assigned).toHaveLength(onIt.length - 1);

      const arjun = await idOf(emailOf.Employee);
      const today = await scheduleOf(hr, arjun);
      expect(today.current).toMatchObject({ effectiveFrom: TODAY, rules: { lateGraceMinutes: 10, standard: { start: '09:00' } } });
      expect(today.planned.map((p) => [p.effectiveFrom, p.rules.lateGraceMinutes, p.rules.standard.start, p.note])).toEqual([[TOMORROW, 30, '09:30', 'New office hours']]);
      expect(today.history).toHaveLength(2);
      const rows = await mod.db().audit.find({ action: 'schedule.assigned', employeeId: arjun }).sort({ $natural: 1 }).toArray();
      expect(rows.at(-1)!.summary).toBe(`Gave Arjun Das the schedule "General 9 to 6" from ${TOMORROW}.`);

      // Tomorrow comes: the new rules apply, and today's are still exactly what they were.
      const oldAssignment = today.current!;
      mod.clock.setTestNow('2026-12-08T04:00:00.000Z');
      try {
        const tomorrow = await scheduleOf(hr, arjun);
        expect(tomorrow.today).toBe(TOMORROW);
        expect(tomorrow.current).toMatchObject({ effectiveFrom: TOMORROW, rules: { lateGraceMinutes: 30 } });
        expect(tomorrow.planned).toEqual([]);
        expect(tomorrow.history.find((h) => h.effectiveFrom === TODAY)).toEqual(oldAssignment);
        // It has started: it is history now and cannot be cancelled.
        const cancel = await hr.delete<ErrorPayload>(`/schedule-assignments/${tomorrow.current!.id}`);
        expect(cancel.status).toBe(409);
        expect(await mod.db().scheduleAssignments.countDocuments({ _id: tomorrow.current!.id })).toBe(1);
      } finally {
        mod.clock.setTestNow(NOW);
      }
    });

    it('replaces a planned schedule for the same date, and lets a planned one be cancelled', async () => {
      const hr = await as('HR');
      const meera = await idByKey('newjoiner');
      const employment = async () => (await mod.db().employees.findOne({ _id: meera }))!.employment;
      expect((await scheduleOf(hr, meera)).planned.map((p) => [p.effectiveFrom, p.rules.name])).toEqual([[NEXT_WEEK, 'General 9 to 6']]);
      expect(await employment()).toEqual([{ from: NEXT_WEEK, to: null }]);

      // The same date again: the planned one is replaced, not doubled.
      expect((await assign(hr, { employeeIds: [meera], scheduleId: await scheduleId('Late shift 10 to 7'), effectiveFrom: NEXT_WEEK })).body.assigned).toHaveLength(1);
      expect((await scheduleOf(hr, meera)).history.map((p) => [p.effectiveFrom, p.rules.name])).toEqual([[NEXT_WEEK, 'Late shift 10 to 7']]);

      // An earlier first day: her employment follows it, because it has not begun.
      expect((await assign(hr, { employeeIds: [meera], scheduleId: await scheduleId('Flexible 8 hours'), effectiveFrom: TOMORROW })).body.assigned).toHaveLength(1);
      const both = await scheduleOf(hr, meera);
      expect(both.current).toBeNull();
      expect(both.planned.map((p) => [p.effectiveFrom, p.rules.name])).toEqual([
        [TOMORROW, 'Flexible 8 hours'],
        [NEXT_WEEK, 'Late shift 10 to 7'],
      ]);
      expect(await employment()).toEqual([{ from: TOMORROW, to: null }]);

      expect((await hr.delete(`/schedule-assignments/${both.planned[0]!.id}`)).status).toBe(204);
      expect(await employment()).toEqual([{ from: NEXT_WEEK, to: null }]);
      expect((await hr.delete(`/schedule-assignments/${both.planned[0]!.id}`)).status).toBe(404);
      expect((await hr.delete(`/schedule-assignments/${both.planned[1]!.id}`)).status).toBe(204);
      // Nothing planned any more: no employment period is left waiting to open.
      expect(await employment()).toEqual([]);
      expect((await scheduleOf(hr, meera)).history).toEqual([]);
      expect((await mod.db().audit.find({ action: 'schedule.assignment.cancelled', employeeId: meera }).sort({ $natural: 1 }).toArray()).map((a) => a.summary)).toEqual([
        `Cancelled the planned schedule "Flexible 8 hours" from ${TOMORROW} for Meera Pillai.`,
        `Cancelled the planned schedule "Late shift 10 to 7" from ${NEXT_WEEK} for Meera Pillai.`,
      ]);
      expect((await hr.delete('/schedule-assignments/asg_000000000000')).status).toBe(404);
    });

    it('takes rules made for one person', async () => {
      const hr = await as('HR');
      const sneha = await idByKey('sneha');
      const own = rules({ name: 'Sneha, mornings', standard: { start: '07:00', end: '13:00', requiredMinutes: 300, fullDayMinutes: 280, halfDayMinutes: 150 }, break: { mode: 'none', minutes: 0, appliesAfter: 0 }, earlyCheckInMinutes: 60 });
      const { body } = await assign(hr, { employeeIds: [sneha], rules: own, effectiveFrom: TOMORROW });
      expect(body.assigned).toHaveLength(1);
      const planned = (await scheduleOf(hr, sneha)).planned[0]!;
      expect(planned).toMatchObject({ scheduleId: null, effectiveFrom: TOMORROW, rules: { name: 'Sneha, mornings', standard: { start: '07:00' } } });
      // It is hers alone: it is not a standard schedule.
      expect(await mod.db().schedules.countDocuments({ name: 'Sneha, mornings' })).toBe(0);
      expect((await mod.db().audit.find({ action: 'schedule.assigned', employeeId: sneha }).sort({ $natural: 1 }).toArray()).at(-1)!.summary).toBe(`Gave Sneha Iyer the custom schedule "Sneha, mornings" from ${TOMORROW}.`);

      const broken = await hr.post<ErrorPayload>('/schedule-assignments', assignment({ employeeIds: [sneha], rules: { ...own, standard: { ...own.standard, fullDayMinutes: 400 } } }));
      expect(broken.status).toBe(422);
      expect(broken.body.fields).toHaveProperty(['rules.standard.fullDayMinutes']);
      // One or the other, never both and never neither.
      expect((await hr.post('/schedule-assignments', assignment({ employeeIds: [sneha], rules: own, scheduleId: await scheduleId('General 9 to 6') }))).status).toBe(400);
      expect((await hr.post('/schedule-assignments', assignment({ employeeIds: [sneha] }))).status).toBe(400);
      expect((await hr.post('/schedule-assignments', assignment({ employeeIds: [], scheduleId: await scheduleId('General 9 to 6') }))).status).toBe(400);
    });

    it('says what happened to each person in a bulk action, and skips nobody silently', async () => {
      const hr = await as('HR');
      const b = await scheduleId('Late shift 10 to 7');
      const ids = [await idByKey('divya'), await idByKey('leela'), 'emp_000000000000', await idByKey('divya'), await idByKey('joseph')];
      const { status, body } = await assign(hr, { employeeIds: ids, scheduleId: b, effectiveFrom: NEXT_WEEK });
      expect(status).toBe(200);
      expect(body.assigned.map((p) => p.name).sort()).toEqual(['Divya Thomas', 'Joseph Mathew']);
      expect(body.skipped).toEqual([
        { employeeId: await idByKey('leela'), name: 'Leela George', reason: 'They are deactivated. Reactivate them first.' },
        { employeeId: 'emp_000000000000', name: '', reason: 'That person no longer exists.' },
      ]);
      // The same person named twice gets one assignment.
      expect(await mod.db().scheduleAssignments.countDocuments({ employeeId: await idByKey('divya'), effectiveFrom: NEXT_WEEK })).toBe(1);
      const tooMany = Array.from({ length: 501 }, (_, i) => `emp_${String(i).padStart(12, '0')}`);
      expect((await hr.post('/schedule-assignments', assignment({ employeeIds: tooMany, scheduleId: b }))).status).toBe(400);
    });

    it('keeps one assignment per person per date when two arrive together', async () => {
      const hr = await as('HR');
      const imran = await idByKey('imran');
      const date = '2026-12-21';
      const [a, b] = [await scheduleId('General 9 to 6'), await scheduleId('Late shift 10 to 7')];
      const results = await Promise.all([assign(hr, { employeeIds: [imran], scheduleId: a, effectiveFrom: date }), assign(hr, { employeeIds: [imran], scheduleId: b, effectiveFrom: date }), assign(hr, { employeeIds: [imran], scheduleId: a, effectiveFrom: date })]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await mod.db().scheduleAssignments.countDocuments({ employeeId: imran, effectiveFrom: date })).toBe(1);
    });
  });

  describe('your own schedule', () => {
    it('is someone else’s to give, change or cancel', async () => {
      const hr = await as('HR');
      const hrId = await idOf(emailOf.HR);
      const before = await mod.db().scheduleAssignments.countDocuments({ employeeId: hrId });
      const { body } = await assign(hr, { employeeIds: [hrId], scheduleId: await scheduleId('Flexible 8 hours') });
      expect(body).toEqual({ assigned: [], skipped: [{ employeeId: hrId, name: 'Rahul Nair', reason: OWN_RECORD_MESSAGE }] });
      const custom = await assign(hr, { employeeIds: [hrId], rules: rules({ name: 'Easy days', standard: { ...rules().standard, fullDayMinutes: 1, halfDayMinutes: 1 } }) });
      expect(custom.body.assigned).toEqual([]);
      expect(await mod.db().scheduleAssignments.countDocuments({ employeeId: hrId })).toBe(before);

      // The Admin gives HR a planned change. HR cannot cancel it; the Admin can.
      const admin = await as('Admin');
      expect((await assign(admin, { employeeIds: [hrId], scheduleId: await scheduleId('Late shift 10 to 7') })).body.assigned).toHaveLength(1);
      const planned = (await scheduleOf(admin, hrId)).planned[0]!;
      const cancel = await hr.delete<ErrorPayload>(`/schedule-assignments/${planned.id}`);
      expect(cancel.status).toBe(403);
      expect(cancel.body.error).toBe(OWN_RECORD_MESSAGE);
      expect((await admin.delete(`/schedule-assignments/${planned.id}`)).status).toBe(204);
      // And the Admin cannot touch their own while HR exists.
      expect((await assign(admin, { employeeIds: [await idOf(emailOf.Admin)], scheduleId: await scheduleId('Late shift 10 to 7') })).body.assigned).toEqual([]);
    });

    it('may be set by an Admin who is the only HR or Admin, and the log marks it', async () => {
      const hrId = await idOf(emailOf.HR);
      const adminId = await idOf(emailOf.Admin);
      await mod.db().employees.updateOne({ _id: hrId }, { $set: { status: 'inactive' } });
      try {
        const admin = await as('Admin');
        const { body } = await assign(admin, { employeeIds: [adminId], scheduleId: await scheduleId('Late shift 10 to 7'), effectiveFrom: NEXT_WEEK });
        expect(body.assigned).toEqual([{ employeeId: adminId, name: 'Anita Menon' }]);
        const row = (await mod.db().audit.find({ action: 'schedule.assigned', employeeId: adminId }).sort({ $natural: 1 }).toArray()).at(-1)!;
        expect(row.selfAdministered).toBe(true);
        const planned = (await scheduleOf(admin, adminId)).planned.find((p) => p.effectiveFrom === NEXT_WEEK)!;
        expect((await admin.delete(`/schedule-assignments/${planned.id}`)).status).toBe(204);
        expect((await mod.db().audit.findOne({ action: 'schedule.assignment.cancelled', employeeId: adminId }))?.selfAdministered).toBe(true);
      } finally {
        await mod.db().employees.updateOne({ _id: hrId }, { $set: { status: 'active' } });
      }
    });
  });

  describe('time zones', () => {
    it('judges "today" in the zone of the rules, not of the server or the company', async () => {
      const admin = await as('Admin');
      const dubai = (await admin.post<Schedule>('/schedules', { rules: rules({ name: 'Dubai office', timeZone: 'Asia/Dubai' }) })).body;
      const india = await scheduleId('Late shift 10 to 7');
      // Two people with no schedule yet.
      const make = async (name: string, email: string) => (await admin.post<{ employee: { id: string } }>('/employees', { name, email, phone: '', role: 'Employee', departmentId: null, designation: '', managerId: null, joinDate: null, schedule: null })).body.employee.id;
      const [inDubai, inIndia] = [await make('Omar Dubai', 'omar.dubai@delta.test'), await make('Indu India', 'indu.india@delta.test')];

      // 19:00 UTC on the 7th: already 00:30 on the 8th in India, still 23:00 on the 7th in Dubai.
      mod.clock.setTestNow('2026-12-07T19:00:00.000Z');
      try {
        const there = await assign(admin, { employeeIds: [inDubai], scheduleId: dubai.id, effectiveFrom: '2026-12-07' });
        expect(there.body.assigned).toHaveLength(1);
        const here = await assign(admin, { employeeIds: [inIndia], scheduleId: india, effectiveFrom: '2026-12-07' });
        expect(here.body.skipped[0]!.reason).toMatch(/Nothing is back-dated/);
        expect((await assign(admin, { employeeIds: [inIndia], scheduleId: india, effectiveFrom: '2026-12-08' })).body.assigned).toHaveLength(1);

        expect((await scheduleOf(admin, inDubai)).today).toBe('2026-12-07');
        expect((await scheduleOf(admin, inIndia)).today).toBe('2026-12-08');
        // A change for the person in Dubai can start on the 8th: it is tomorrow there, though it is today in India.
        expect((await assign(admin, { employeeIds: [inDubai], scheduleId: india, effectiveFrom: '2026-12-08' })).body.assigned).toHaveLength(1);
        expect((await assign(admin, { employeeIds: [inIndia], scheduleId: dubai.id, effectiveFrom: '2026-12-08' })).body.skipped[0]!.reason).toMatch(/tomorrow at the earliest/);
      } finally {
        mod.clock.setTestNow(NOW);
      }
    });
  });
});
