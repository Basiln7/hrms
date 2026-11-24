/*
 * End-to-end tests of people and departments (Phase 2) against a real MongoDB: lists and who
 * may see whom, adding and changing people, roles, managers, deactivation, passwords.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWN_RECORD_MESSAGE, PASSWORD_CHANGE_REQUIRED, type DepartmentRow, type Employee, type EmployeeInput, type EmployeeRow, type EmployeeSchedulePayload, type ErrorPayload, type MePayload, type NewEmployeeInput, type Page, type PersonOption, type ScheduleRow, type TemporaryPasswordPayload } from '@delta-hrms/shared';
import { as, boot, Client, emailOf, everythingAnswered, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

/** Monday 7 December 2026, 09:30 in India. */
const NOW = '2026-12-07T04:00:00.000Z';
const TODAY = '2026-12-07';
const YESTERDAY = '2026-12-06';
const TOMORROW = '2026-12-08';
const TEMPORARY = /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/;

beforeAll(async () => {
  await boot('people');
  if (!reachable) return;
  mod.clock.setTestNow(NOW);
  await resetToSample();
});
afterAll(shutdown);

const person = async (email: string) => {
  const doc = (await mod.db().employees.findOne({ email }))!;
  return { ...doc, id: doc._id };
};
const idByKey = async (key: string) => idOf(mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.email);
const departmentId = async (name: string) => (await mod.db().departments.findOne({ name }))!._id;
const scheduleId = async (name: string) => (await mod.db().schedules.findOne({ name }))!._id;

/** The form for adding someone, with sensible values that each test changes. */
const newcomer = (over: Partial<NewEmployeeInput> = {}): NewEmployeeInput => ({
  name: 'Priya Raman',
  email: 'priya.raman@delta.test',
  phone: '',
  role: 'Employee',
  departmentId: null,
  designation: 'Analyst',
  managerId: null,
  joinDate: null,
  schedule: null,
  ...over,
});

/** A person's record as the edit form sends it back. */
const detailsOf = (e: Employee, over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  name: e.name,
  email: e.email,
  phone: e.phone,
  role: e.role,
  departmentId: e.departmentId,
  designation: e.designation,
  managerId: e.managerId,
  joinDate: e.joinDate,
  ...over,
});

describe.skipIf(!reachable)('people', () => {
  describe('lists, and who may see whom', () => {
    it('shows HR everyone, by name, with the names their records point at', async () => {
      const { status, body } = await (await as('HR')).get<Page<EmployeeRow>>('/employees');
      expect(status).toBe(200);
      expect(body.total).toBe(mod.seed.DEMO_PEOPLE.length);
      expect(body.pageSize).toBe(25);
      expect(body.items.map((e) => e.name)).toEqual([...body.items.map((e) => e.name)].sort((a, b) => a.localeCompare(b)));
      const arjun = body.items.find((e) => e.email === emailOf.Employee)!;
      expect(arjun).toMatchObject({ departmentName: 'Sales', managerName: 'Fatima Khan', scheduleName: 'General 9 to 6', role: 'Employee' });
      expect(arjun).not.toHaveProperty('passwordHash');
      // Someone with no schedule, and someone whose schedule has not started yet.
      expect(body.items.find((e) => e.name === 'Kiran Babu')!.scheduleName).toBeNull();
      expect(body.items.find((e) => e.name === 'Meera Pillai')!.scheduleName).toBeNull();
    });

    it('searches and filters', async () => {
      const hr = await as('HR');
      const names = async (query: string) => (await hr.get<Page<EmployeeRow>>(`/employees?${query}`)).body.items.map((e) => e.name);
      expect(await names('search=fatima')).toEqual(['Fatima Khan']);
      expect(await names('search=EMP-0004')).toEqual(['Arjun Das']);
      expect(await names('search=sneha.iyer%40')).toEqual(['Sneha Iyer']);
      expect(await names('search=designer')).toEqual(['Sneha Iyer']);
      expect(await names(`departmentId=${await departmentId('Support')}`)).toEqual(['Kiran Babu', 'Leela George', 'Nisha Varma']);
      expect(await names('role=Manager')).toEqual(['Fatima Khan', 'Nisha Varma', 'Vivek Sharma']);
      expect(await names('status=inactive')).toEqual(['Leela George']);
      expect(await names('status=invited')).toEqual(['Meera Pillai']);
      expect(await names(`managerId=${await idByKey('lead')}`)).toEqual(['Divya Thomas', 'Imran Sheikh']);
      expect(await names(`role=Employee&departmentId=${await departmentId('Operations')}`)).toEqual(['Joseph Mathew', 'Sneha Iyer']);
    });

    it('reads search text as text, never as a pattern', async () => {
      const hr = await as('HR');
      for (const text of ['.*', 'a|b', '(', '[a-z]+', '\\', '$']) {
        const { status, body } = await hr.get<Page<EmployeeRow>>(`/employees?search=${encodeURIComponent(text)}`);
        expect(status, text).toBe(200);
        expect(body.total, text).toBe(0);
      }
    });

    it('refuses a filter it does not know', async () => {
      const hr = await as('HR');
      expect((await hr.get('/employees?salary=high')).status).toBe(400);
      expect((await hr.get('/employees?role=Owner')).status).toBe(400);
      expect((await hr.get('/employees?page=0')).status).toBe(400);
    });

    it('shows a Manager themselves and everyone under them, and nobody else', async () => {
      const manager = await as('Manager');
      const all = (await manager.get<Page<EmployeeRow>>('/employees')).body;
      expect(all.items.map((e) => e.name)).toEqual(['Arjun Das', 'Divya Thomas', 'Fatima Khan', 'Imran Sheikh', 'Meera Pillai', 'Vivek Sharma']);
      const team = (await manager.get<Page<EmployeeRow>>('/employees?team=1')).body;
      expect(team.items.map((e) => e.name)).toEqual(['Arjun Das', 'Divya Thomas', 'Imran Sheikh', 'Meera Pillai', 'Vivek Sharma']);
      // A filter cannot reach outside the scope.
      expect((await manager.get<Page<EmployeeRow>>(`/employees?departmentId=${await departmentId('Support')}`)).body.total).toBe(0);
      expect((await manager.get<Page<EmployeeRow>>('/employees?search=anita')).body.total).toBe(0);
    });

    it('shows an Employee only themselves', async () => {
      const { body } = await (await as('Employee')).get<Page<EmployeeRow>>('/employees');
      expect(body.items.map((e) => e.name)).toEqual(['Arjun Das']);
      expect((await (await as('Employee')).get<Page<EmployeeRow>>('/employees?team=1')).body.total).toBe(0);
    });

    it('answers "not found" for someone out of scope, word for word as for nobody', async () => {
      const employee = await as('Employee');
      const mine = await idOf(emailOf.Employee);
      expect((await employee.get(`/employees/${mine}`)).status).toBe(200);
      const other = await employee.get<ErrorPayload>(`/employees/${await idByKey('divya')}`);
      const nobody = await employee.get<ErrorPayload>('/employees/emp_000000000000');
      expect(other.status).toBe(404);
      expect(nobody.status).toBe(404);
      expect(other.body).toEqual(nobody.body);
      expect((await employee.get(`/employees/${await idOf(emailOf.Manager)}`)).status).toBe(404);
      expect((await employee.get('/employees/not-an-id')).status).toBe(400);

      const manager = await as('Manager');
      expect((await manager.get(`/employees/${mine}`)).status).toBe(200);
      expect((await manager.get(`/employees/${await idByKey('divya')}`)).status, 'a report of a report').toBe(200);
      expect((await manager.get(`/employees/${await idByKey('kiran')}`)).status, 'another team').toBe(404);
      expect((await manager.get(`/employees/${await idOf(emailOf.Admin)}`)).status).toBe(404);
      expect((await manager.get(`/employees/${await idOf(emailOf.HR)}`)).status).toBe(404);

      const hr = await as('HR');
      expect((await hr.get(`/employees/${await idByKey('kiran')}`)).status).toBe(200);
      expect((await hr.get('/employees/emp_000000000000')).status).toBe(404);
    });

    it('scopes a person’s schedule the same way, and lets everyone read their own', async () => {
      const employee = await as('Employee');
      const own = await employee.get<EmployeeSchedulePayload>(`/employees/${await idOf(emailOf.Employee)}/schedule`);
      expect(own.status).toBe(200);
      expect(own.body.today).toBe(TODAY);
      expect(own.body.current?.rules.name).toBe('General 9 to 6');
      expect((await employee.get(`/employees/${await idByKey('divya')}/schedule`)).status).toBe(404);
      expect((await (await as('Manager')).get(`/employees/${await idByKey('divya')}/schedule`)).status).toBe(200);
      expect((await (await as('Manager')).get(`/employees/${await idByKey('kiran')}/schedule`)).status).toBe(404);
    });

    it('gives the forms a brief list of everyone, only to people who may see everyone', async () => {
      const { status, body } = await (await as('HR')).get<PersonOption[]>('/employees/picker');
      expect(status).toBe(200);
      // Everyone but Leela, who has left.
      expect(body).toHaveLength(mod.seed.DEMO_PEOPLE.length - 1);
      expect(body.find((p) => p.name === 'Arjun Das')).toEqual({ id: await idOf(emailOf.Employee), code: 'EMP-0004', name: 'Arjun Das', role: 'Employee', departmentId: await departmentId('Sales'), departmentName: 'Sales', scheduleName: 'General 9 to 6', calendarName: null });
      expect(body.some((p) => p.name === 'Leela George')).toBe(false);
      expect((await (await as('Manager')).get('/employees/picker')).status).toBe(403);
      expect((await (await as('Employee')).get('/employees/picker')).status).toBe(403);
    });

    it('tells each person their own department and schedule', async () => {
      const me = (await (await as('Employee')).get<MePayload>('/me')).body;
      expect(me.employee.departmentName).toBe('Sales');
      expect(me.scheduleName).toBe('General 9 to 6');
      const kiran = (await (await signIn('kiran.babu@delta.test')).get<MePayload>('/me')).body;
      expect(kiran.scheduleName).toBeNull();
    });
  });

  describe('adding someone', () => {
    it('is for HR and Admin only', async () => {
      for (const role of ['Employee', 'Manager'] as const) {
        expect((await (await as(role)).post('/employees', newcomer())).status, role).toBe(403);
      }
      expect(await mod.db().employees.countDocuments({ email: 'priya.raman@delta.test' })).toBe(0);
    });

    it('creates them with a code, a temporary password shown once, and their first schedule', async () => {
      const hr = await as('HR');
      const before = await mod.db().employees.countDocuments();
      const input = newcomer({ departmentId: await departmentId('Operations'), managerId: await idOf(emailOf.Admin), joinDate: '2019-04-01', schedule: { scheduleId: await scheduleId('General 9 to 6'), effectiveFrom: TOMORROW } });
      const { status, body } = await hr.post<TemporaryPasswordPayload>('/employees', input);
      expect(status).toBe(201);
      expect(body.temporaryPassword).toMatch(TEMPORARY);
      expect(body.employee).toMatchObject({ name: 'Priya Raman', code: `EMP-${String(before + 1).padStart(4, '0')}`, status: 'invited', mustChangePassword: true, role: 'Employee' });
      // Attendance starts with the schedule, not with the joining date in 2019: no years of absences.
      expect(body.employee.employment).toEqual([{ from: TOMORROW, to: null }]);
      expect(body.employee.joinDate).toBe('2019-04-01');

      const stored = (await mod.db().employees.findOne({ _id: body.employee.id }))!;
      expect(JSON.stringify(stored)).not.toContain(body.temporaryPassword);
      expect(stored.passwordHash).toMatch(/^scrypt\$/);
      const schedule = (await hr.get<EmployeeSchedulePayload>(`/employees/${body.employee.id}/schedule`)).body;
      expect(schedule.current).toBeNull();
      expect(schedule.planned.map((a) => [a.rules.name, a.effectiveFrom])).toEqual([['General 9 to 6', TOMORROW]]);

      const audit = await mod.db().audit.find({ employeeId: body.employee.id }).sort({ $natural: 1 }).toArray();
      expect(audit.map((a) => a.action).sort()).toEqual(['employee.created', 'schedule.assigned']);
      expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
      expect(JSON.stringify(audit)).not.toContain('scrypt$');

      // They can sign in with it, and are held at the door until they choose their own.
      const priya = await signIn('priya.raman@delta.test', body.temporaryPassword);
      expect((await priya.get<ErrorPayload>('/departments')).body.code).toBe(PASSWORD_CHANGE_REQUIRED);
    });

    it('checks what it is given, and creates nobody when something is wrong', async () => {
      const hr = await as('HR');
      const before = await mod.db().employees.countDocuments();
      const refused = async (over: Partial<NewEmployeeInput>, status: number, field?: string) => {
        const answer = await hr.post<ErrorPayload>('/employees', newcomer({ email: 'someone.new@delta.test', ...over }));
        expect(answer.status, JSON.stringify(over)).toBe(status);
        if (field) expect(answer.body.fields, JSON.stringify(over)).toHaveProperty([field]);
      };
      await refused({ email: emailOf.Employee }, 422, 'email');
      await refused({ email: 'ARJUN.typo@' }, 400, 'email');
      await refused({ email: 'Employee@Delta.Test' }, 422, 'email');
      await refused({ name: 'P' }, 400, 'name');
      await refused({ departmentId: 'dep_000000000000' }, 422, 'departmentId');
      await refused({ managerId: 'emp_000000000000' }, 422, 'managerId');
      await refused({ managerId: await idOf(emailOf.Employee) }, 422, 'managerId');
      await refused({ managerId: await idByKey('leela') }, 422, 'managerId');
      await refused({ joinDate: '2026-02-30' }, 400, 'joinDate');
      await refused({ phone: 'ring me' }, 400, 'phone');
      await refused({ schedule: { scheduleId: await scheduleId('General 9 to 6'), effectiveFrom: YESTERDAY } }, 422, 'schedule.effectiveFrom');
      await refused({ schedule: { scheduleId: 'sch_000000000000', effectiveFrom: TOMORROW } }, 422, 'schedule.scheduleId');
      await refused({ ...({ passwordHash: 'x' } as object) }, 400);
      await refused({ ...({ status: 'active' } as object) }, 400);
      expect(await mod.db().employees.countDocuments()).toBe(before);
    });

    it('lets HR add Employees and Managers, and only an Admin add HR and Admins', async () => {
      const hr = await as('HR');
      expect((await hr.post('/employees', newcomer({ email: 'new.hr@delta.test', role: 'HR' }))).status).toBe(403);
      expect((await hr.post('/employees', newcomer({ email: 'new.admin@delta.test', role: 'Admin' }))).status).toBe(403);
      expect((await hr.post('/employees', newcomer({ name: 'Mona Lead', email: 'mona.lead@delta.test', role: 'Manager' }))).status).toBe(201);

      const admin = await as('Admin');
      const made = await admin.post<TemporaryPasswordPayload>('/employees', newcomer({ name: 'Hari Second', email: 'hari.second@delta.test', role: 'HR' }));
      expect(made.status).toBe(201);
      expect(made.body.employee.employment).toEqual([]);
      // Clean up the second HR so later tests have one HR and one Admin again.
      await mod.db().employees.deleteOne({ _id: made.body.employee.id });
    });
  });

  describe('changing someone', () => {
    it('lets HR change an ordinary person’s details, and logs exactly what changed', async () => {
      const hr = await as('HR');
      const joseph = (await hr.get<EmployeeRow>(`/employees/${await idByKey('joseph')}`)).body;
      const support = await departmentId('Support');
      const nisha = await idByKey('nisha');
      const { status, body } = await hr.patch<Employee>(`/employees/${joseph.id}`, detailsOf(joseph, { designation: 'Senior Accountant', departmentId: support, managerId: nisha }));
      expect(status).toBe(200);
      expect(body).toMatchObject({ designation: 'Senior Accountant', departmentId: support, managerId: nisha, name: 'Joseph Mathew' });
      const row = (await mod.db().audit.find({ employeeId: joseph.id, action: 'employee.updated' }).sort({ $natural: 1 }).toArray()).at(-1)!;
      expect(row.before).toEqual({ designation: 'Accountant', departmentId: joseph.departmentId, managerId: joseph.managerId });
      expect(row.after).toEqual({ designation: 'Senior Accountant', departmentId: support, managerId: nisha });
      // Saving the form again without changing anything writes nothing.
      const count = await mod.db().audit.countDocuments({ employeeId: joseph.id });
      expect((await hr.patch(`/employees/${joseph.id}`, detailsOf(body))).status).toBe(200);
      expect(await mod.db().audit.countDocuments({ employeeId: joseph.id })).toBe(count);
    });

    it('refuses an email someone else has, and fields it does not know', async () => {
      const hr = await as('HR');
      const divya = (await hr.get<EmployeeRow>(`/employees/${await idByKey('divya')}`)).body;
      const taken = await hr.patch<ErrorPayload>(`/employees/${divya.id}`, detailsOf(divya, { email: emailOf.Employee }));
      expect(taken.status).toBe(422);
      expect(taken.body.fields).toHaveProperty('email');
      expect((await hr.patch(`/employees/${divya.id}`, { ...detailsOf(divya), status: 'inactive' })).status).toBe(400);
      expect((await hr.patch(`/employees/${divya.id}`, { ...detailsOf(divya), mustChangePassword: false })).status).toBe(400);
      expect((await hr.patch(`/employees/${divya.id}`, { ...detailsOf(divya), code: 'EMP-0001' })).status).toBe(400);
    });

    it('keeps HR and Admin accounts for an Admin to change', async () => {
      const hr = await as('HR');
      const adminRow = (await hr.get<EmployeeRow>(`/employees/${await idOf(emailOf.Admin)}`)).body;
      const refused = await hr.patch<ErrorPayload>(`/employees/${adminRow.id}`, detailsOf(adminRow, { designation: 'Demoted' }));
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('Only an Admin can change an HR or Admin account.');
      expect((await hr.patch(`/employees/${adminRow.id}`, detailsOf(adminRow, { role: 'Employee' }))).status).toBe(403);
      expect((await person(emailOf.Admin)).role).toBe('Admin');
    });

    it('stops HR handing out the HR and Admin roles', async () => {
      const hr = await as('HR');
      const arjun = (await hr.get<EmployeeRow>(`/employees/${await idOf(emailOf.Employee)}`)).body;
      for (const role of ['HR', 'Admin'] as const) {
        const answer = await hr.patch<ErrorPayload>(`/employees/${arjun.id}`, detailsOf(arjun, { role }));
        expect(answer.status, role).toBe(403);
        expect(answer.body.error).toBe('Only an Admin can give the HR and Admin roles.');
      }
      expect((await person(emailOf.Employee)).role).toBe('Employee');
    });

    it('stops everyone using an HR power on their own record', async () => {
      const hr = await as('HR');
      const me = (await hr.get<EmployeeRow>(`/employees/${await idOf(emailOf.HR)}`)).body;
      const own = await hr.patch<ErrorPayload>(`/employees/${me.id}`, detailsOf(me, { designation: 'Head of HR' }));
      expect(own.status).toBe(403);
      expect(own.body.error).toBe(OWN_RECORD_MESSAGE);
      // The Admin too, while there is an HR who could do it.
      const admin = await as('Admin');
      const adminRow = (await admin.get<EmployeeRow>(`/employees/${await idOf(emailOf.Admin)}`)).body;
      expect((await admin.patch(`/employees/${adminRow.id}`, detailsOf(adminRow, { designation: 'Owner' }))).status).toBe(403);
      expect((await admin.patch(`/employees/${adminRow.id}`, detailsOf(adminRow, { role: 'HR' }))).status).toBe(403);
    });

    it('lets an Admin who is the only HR or Admin change their own details, marks it, and still never their own role', async () => {
      const hrId = await idOf(emailOf.HR);
      await mod.db().employees.updateOne({ _id: hrId }, { $set: { status: 'inactive' } });
      try {
        const admin = await as('Admin');
        const me = (await admin.get<EmployeeRow>(`/employees/${await idOf(emailOf.Admin)}`)).body;
        expect((await admin.patch(`/employees/${me.id}`, detailsOf(me, { designation: 'Founder' }))).status).toBe(200);
        const row = (await mod.db().audit.find({ employeeId: me.id, action: 'employee.updated' }).sort({ $natural: 1 }).toArray()).at(-1)!;
        expect(row.selfAdministered).toBe(true);
        const role = await admin.patch<ErrorPayload>(`/employees/${me.id}`, detailsOf({ ...me, designation: 'Founder' }, { role: 'HR' }));
        expect(role.status).toBe(403);
        expect(role.body.error).toBe('You cannot change your own role.');
        await admin.patch(`/employees/${me.id}`, detailsOf(me));
      } finally {
        await mod.db().employees.updateOne({ _id: hrId }, { $set: { status: 'active' } });
      }
    });

    it('accepts only a Manager, HR or Admin as a manager, and no loops', async () => {
      const hr = await as('HR');
      const row = async (key: string) => (await hr.get<EmployeeRow>(`/employees/${await idByKey(key)}`)).body;
      const refused = async (target: EmployeeRow, managerId: string) => {
        const answer = await hr.patch<ErrorPayload>(`/employees/${target.id}`, detailsOf(target, { managerId }));
        expect(answer.status).toBe(422);
        expect(answer.body.fields).toHaveProperty('managerId');
        return answer.body.error;
      };
      const fatima = await row('manager');
      const kiran = await row('kiran');
      expect(await refused(kiran, await idByKey('divya'))).toMatch(/Only a Manager, HR or Admin/);
      expect(await refused(kiran, await idByKey('leela'))).toMatch(/deactivated/);
      expect(await refused(kiran, 'emp_000000000000')).toMatch(/does not exist/);
      expect(await refused(fatima, fatima.id)).toBe('Nobody can be their own manager.');
      expect(await refused(fatima, await idByKey('lead'))).toBe('That would put them above their own manager.');
      expect((await person(emailOf.Manager)).managerId).toBeNull();
    });

    it('makes a Manager of an Employee, and keeps them one while people report to them', async () => {
      const hr = await as('HR');
      const kiran = (await hr.get<EmployeeRow>(`/employees/${await idByKey('kiran')}`)).body;
      const imran = (await hr.get<EmployeeRow>(`/employees/${await idByKey('imran')}`)).body;
      expect((await hr.patch(`/employees/${kiran.id}`, detailsOf(kiran, { role: 'Manager' }))).status).toBe(200);
      expect((await mod.db().audit.find({ employeeId: kiran.id, action: 'employee.role.changed' }).sort({ $natural: 1 }).toArray()).at(-1)!.summary).toBe("Changed Kiran Babu's role from Employee to Manager.");
      expect((await hr.patch(`/employees/${imran.id}`, detailsOf(imran, { managerId: kiran.id }))).status).toBe(200);

      const demote = await hr.patch<ErrorPayload>(`/employees/${kiran.id}`, detailsOf(kiran, { role: 'Employee' }));
      expect(demote.status).toBe(409);
      expect(demote.body.error).toMatch(/Move those people/);
      expect((await hr.patch(`/employees/${imran.id}`, detailsOf(imran))).status).toBe(200);
      expect((await hr.patch(`/employees/${kiran.id}`, detailsOf(kiran, { role: 'Employee' }))).status).toBe(200);
    });

    it('takes effect on the person’s very next request', async () => {
      const admin = await as('Admin');
      const divya = await signIn('divya.thomas@delta.test');
      expect((await divya.get<Page<EmployeeRow>>('/employees')).body.total).toBe(1);
      const row = (await admin.get<EmployeeRow>(`/employees/${await idByKey('divya')}`)).body;
      expect((await admin.patch(`/employees/${row.id}`, detailsOf(row, { role: 'HR' }))).status).toBe(200);
      // No new sign-in: the same session now sees everyone.
      expect((await divya.get<Page<EmployeeRow>>('/employees')).body.total).toBeGreaterThan(10);
      expect((await admin.patch(`/employees/${row.id}`, detailsOf(row))).status).toBe(200);
      expect((await divya.get<Page<EmployeeRow>>('/employees')).body.total).toBe(1);
    });
  });

  describe('there is always an Admin', () => {
    /** A second Admin, signed in, for the tests that need two. */
    const secondAdmin = async (email: string) => {
      const admin = await as('Admin');
      const made = (await admin.post<TemporaryPasswordPayload>('/employees', newcomer({ name: 'Second Admin', email, role: 'Admin' }))).body;
      const second = await signIn(email, made.temporaryPassword);
      expect((await second.post('/me/password', { current: made.temporaryPassword, next: 'second-admin-own-password' })).status).toBe(204);
      return { admin, second, secondRow: made.employee };
    };
    const activeAdmins = () => mod.db().employees.countDocuments({ role: 'Admin', status: { $ne: 'inactive' } });

    it('tracks Admins as they are made and unmade', async () => {
      const { admin, secondRow } = await secondAdmin('second.admin@delta.test');
      const first = await idOf(emailOf.Admin);
      expect(((await mod.db().meta.findOne({ _id: 'admins' }))!.value as string[]).sort()).toEqual([first, secondRow.id].sort());
      expect((await admin.patch(`/employees/${secondRow.id}`, detailsOf(secondRow, { role: 'Employee' }))).status).toBe(200);
      expect((await mod.db().meta.findOne({ _id: 'admins' }))!.value).toEqual([first]);
      await mod.db().employees.deleteOne({ _id: secondRow.id });
    });

    it('leaves one when two Admins take the role from each other at the same instant', async () => {
      const { admin, second, secondRow } = await secondAdmin('rival.admin@delta.test');
      const firstRow = (await admin.get<EmployeeRow>(`/employees/${await idOf(emailOf.Admin)}`)).body;
      const results = await Promise.all([admin.patch(`/employees/${secondRow.id}`, detailsOf(secondRow, { role: 'HR' })), second.patch(`/employees/${firstRow.id}`, detailsOf(firstRow, { role: 'HR' }))]);
      // One wins. The other is stopped by the guard (409), or, if their request arrived after they
      // had already stopped being an Admin, at the door (403). Either way one Admin is left.
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
      expect(await activeAdmins()).toBe(1);
      expect((await mod.db().meta.findOne({ _id: 'admins' }))!.value).toHaveLength(1);
      // Put the sample company back: Anita the Admin, and no rival.
      await mod.db().employees.updateOne({ _id: firstRow.id }, { $set: { role: 'Admin' } });
      await mod.db().employees.deleteOne({ _id: secondRow.id });
      await mod.admins.rebuildAdmins();
    });

    it('leaves one when two Admins deactivate each other at the same instant', async () => {
      const { admin, second, secondRow } = await secondAdmin('other.admin@delta.test');
      const first = await idOf(emailOf.Admin);
      const results = await Promise.all([
        admin.post(`/employees/${secondRow.id}/status`, { status: 'inactive', lastWorkingDay: TODAY }),
        second.post(`/employees/${first}/status`, { status: 'inactive', lastWorkingDay: TODAY }),
      ]);
      // Whoever was deactivated first may find their own request refused at the door instead (401): either way one Admin is left.
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await activeAdmins()).toBe(1);
      await mod.db().employees.updateOne({ _id: first }, { $set: { status: 'active', role: 'Admin' } });
      await mod.db().employees.deleteOne({ _id: secondRow.id });
      await mod.admins.rebuildAdmins();
      await resetToSample();
    });
  });

  describe('deactivating and reactivating', () => {
    it('closes their employment on the last working day and signs them out everywhere', async () => {
      const hr = await as('HR');
      const imranId = await idByKey('imran');
      const imran = await signIn('imran.sheikh@delta.test');
      expect((await imran.get('/me')).status).toBe(200);

      const { status, body } = await hr.post<Employee>(`/employees/${imranId}/status`, { status: 'inactive', lastWorkingDay: TODAY });
      expect(status).toBe(200);
      expect(body).toMatchObject({ status: 'inactive', employment: [{ from: TODAY, to: TODAY }] });
      expect((await imran.get('/me')).status).toBe(401);
      expect(await mod.db().sessions.countDocuments({ employeeId: imranId })).toBe(0);
      expect((await new Client().post('/auth/login', { email: 'imran.sheikh@delta.test', password: mod.seed.DEMO_PASSWORD })).status).toBe(403);
      expect((await mod.db().audit.findOne({ employeeId: imranId, action: 'employee.deactivated' }))?.summary).toBe(`Deactivated Imran Sheikh. Last working day: ${TODAY}.`);
      expect((await hr.post(`/employees/${imranId}/status`, { status: 'inactive', lastWorkingDay: TODAY })).status).toBe(409);
    });

    it('wants a last working day that is not in the future', async () => {
      const hr = await as('HR');
      const answer = await hr.post<ErrorPayload>(`/employees/${await idByKey('divya')}/status`, { status: 'inactive', lastWorkingDay: TOMORROW });
      expect(answer.status).toBe(422);
      expect(answer.body.fields).toHaveProperty('lastWorkingDay');
      expect((await hr.post(`/employees/${await idByKey('divya')}/status`, { status: 'inactive' })).status).toBe(400);
      expect((await person('divya.thomas@delta.test')).status).toBe('active');
    });

    it('leaves no days to account for when someone goes before their first day', async () => {
      const hr = await as('HR');
      // Meera's schedule starts next week.
      const { body } = await hr.post<Employee>(`/employees/${await idByKey('newjoiner')}/status`, { status: 'inactive', lastWorkingDay: TODAY });
      expect(body.employment).toEqual([]);
    });

    it('will not let anyone deactivate themselves, or HR an Admin', async () => {
      const hr = await as('HR');
      expect((await hr.post(`/employees/${await idOf(emailOf.HR)}/status`, { status: 'inactive', lastWorkingDay: TODAY })).status).toBe(400);
      expect((await hr.post(`/employees/${await idOf(emailOf.Admin)}/status`, { status: 'inactive', lastWorkingDay: TODAY })).status).toBe(403);
      const admin = await as('Admin');
      expect((await admin.post(`/employees/${await idOf(emailOf.Admin)}/status`, { status: 'inactive', lastWorkingDay: TODAY })).status).toBe(400);
      expect((await person(emailOf.Admin)).status).toBe('active');
    });

    it('keeps the people under a deactivated manager in sight of the manager above', async () => {
      const hr = await as('HR');
      expect((await hr.post(`/employees/${await idByKey('lead')}/status`, { status: 'inactive', lastWorkingDay: TODAY })).status).toBe(200);
      const team = (await (await as('Manager')).get<Page<EmployeeRow>>('/employees?team=1')).body.items.map((e) => e.name);
      expect(team).toContain('Divya Thomas');
      expect(team).toContain('Vivek Sharma');
    });

    it('brings someone back from a day, today at the earliest, without counting the time away', async () => {
      const hr = await as('HR');
      const leelaId = await idByKey('leela');
      const early = await hr.post<ErrorPayload>(`/employees/${leelaId}/status`, { status: 'active', from: YESTERDAY });
      expect(early.status).toBe(422);
      expect(early.body.fields).toHaveProperty('from');

      const { status, body } = await hr.post<Employee>(`/employees/${leelaId}/status`, { status: 'active', from: TODAY });
      expect(status).toBe(200);
      // She has never signed in to the HRMS, so she is Invited again, not Active.
      expect(body.status).toBe('invited');
      expect(body.employment).toEqual([
        { from: '2026-03-02', to: '2026-10-30' },
        { from: TODAY, to: null },
      ]);
      expect((await hr.post(`/employees/${leelaId}/status`, { status: 'active', from: TODAY })).status).toBe(409);
      expect((await new Client().post('/auth/login', { email: 'leela.george@delta.test', password: mod.seed.DEMO_PASSWORD })).status).toBe(204);
    });

    it('opens a period for someone brought back who has a schedule but never started', async () => {
      const hr = await as('HR');
      const { body } = await hr.post<Employee>(`/employees/${await idByKey('newjoiner')}/status`, { status: 'active', from: TOMORROW });
      expect(body.employment).toEqual([{ from: TOMORROW, to: null }]);
    });
  });

  describe('resetting a password', () => {
    it('gives a new temporary one, shown once, and ends their sessions', async () => {
      const hr = await as('HR');
      const arjunId = await idOf(emailOf.Employee);
      const arjun = await as('Employee');
      const { status, body } = await hr.post<TemporaryPasswordPayload>(`/employees/${arjunId}/reset-password`);
      expect(status).toBe(200);
      expect(body.temporaryPassword).toMatch(TEMPORARY);
      expect(body.employee.mustChangePassword).toBe(true);
      expect((await arjun.get('/me')).status).toBe(401);
      expect((await new Client().post('/auth/login', { email: emailOf.Employee, password: mod.seed.DEMO_PASSWORD })).status).toBe(401);

      const back = await signIn(emailOf.Employee, body.temporaryPassword);
      expect((await back.get<ErrorPayload>('/employees')).body.code).toBe(PASSWORD_CHANGE_REQUIRED);
      // Back to the sample password, for the tests that follow.
      expect((await back.post('/me/password', { current: body.temporaryPassword, next: mod.seed.DEMO_PASSWORD })).status).toBe(204);

      const audit = await mod.db().audit.find({ employeeId: arjunId, action: 'employee.password.reset' }).sort({ $natural: 1 }).toArray();
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
    });

    it('is not for your own password, an Admin’s by HR, or someone deactivated', async () => {
      const hr = await as('HR');
      expect((await hr.post(`/employees/${await idOf(emailOf.HR)}/reset-password`)).status).toBe(400);
      expect((await hr.post(`/employees/${await idOf(emailOf.Admin)}/reset-password`)).status).toBe(403);
      expect((await hr.post(`/employees/${await idByKey('imran')}/reset-password`)).status).toBe(409);
      expect((await (await as('Manager')).post(`/employees/${await idOf(emailOf.Employee)}/reset-password`)).status).toBe(403);
      // An Admin may reset HR's.
      const { status, body } = await (await as('Admin')).post<TemporaryPasswordPayload>(`/employees/${await idOf(emailOf.HR)}/reset-password`);
      expect(status).toBe(200);
      const hrAgain = await signIn(emailOf.HR, body.temporaryPassword);
      expect((await hrAgain.post('/me/password', { current: body.temporaryPassword, next: mod.seed.DEMO_PASSWORD })).status).toBe(204);
    });
  });

  describe('departments', () => {
    it('gives everyone the names, and the head counts to those who may see everyone', async () => {
      const forEmployee = (await (await as('Employee')).get<DepartmentRow[]>('/departments')).body;
      expect(forEmployee.map((d) => d.name)).toEqual(['Operations', 'Sales', 'Support']);
      expect(forEmployee.every((d) => d.peopleCount === 0)).toBe(true);
      const forHr = (await (await as('HR')).get<DepartmentRow[]>('/departments')).body;
      const sales = forHr.find((d) => d.name === 'Sales')!;
      expect(sales.peopleCount).toBe(await mod.db().employees.countDocuments({ departmentId: sales.id, status: { $ne: 'inactive' } }));
      expect(sales.peopleCount).toBeGreaterThan(0);
    });

    it('lets HR add, rename and delete them, never two with one name, never one with people in it', async () => {
      const hr = await as('HR');
      const made = await hr.post<DepartmentRow>('/departments', { name: 'Finance' });
      expect(made.status).toBe(201);
      const same = await hr.post<ErrorPayload>('/departments', { name: '  finance ' });
      expect(same.status).toBe(422);
      expect(same.body.fields).toHaveProperty('name');
      expect((await hr.post('/departments', { name: ' ' })).status).toBe(400);

      expect((await hr.patch(`/departments/${made.body.id}`, { name: 'Finance & Accounts' })).status).toBe(204);
      expect((await hr.patch(`/departments/${made.body.id}`, { name: 'SALES' })).status).toBe(422);
      expect((await mod.db().departments.findOne({ _id: made.body.id }))?.name).toBe('Finance & Accounts');

      const sales = await departmentId('Sales');
      const full = await hr.delete<ErrorPayload>(`/departments/${sales}`);
      expect(full.status).toBe(409);
      expect(full.body.error).toMatch(/still in Sales/);
      expect((await hr.delete(`/departments/${made.body.id}`)).status).toBe(204);
      expect((await hr.delete(`/departments/${made.body.id}`)).status).toBe(404);
      expect((await mod.db().audit.find({ targetType: 'department' }).sort({ $natural: 1 }).toArray()).map((a) => a.action)).toEqual(['department.created', 'department.renamed', 'department.deleted']);
    });

    it('keeps changes for HR and Admin', async () => {
      for (const role of ['Employee', 'Manager'] as const) {
        const client = await as(role);
        expect((await client.post('/departments', { name: 'Secret' })).status, role).toBe(403);
        expect((await client.patch(`/departments/${await departmentId('Sales')}`, { name: 'Mine' })).status, role).toBe(403);
        expect((await client.delete(`/departments/${await departmentId('Sales')}`)).status, role).toBe(403);
      }
    });
  });

  describe('long lists', () => {
    it('come a page at a time', async () => {
      const template = await person(emailOf.Employee);
      const extra = Array.from({ length: 30 }, (_, i) => {
        const { id: _id, ...rest } = template;
        return { ...rest, _id: mod.ids.newId('emp'), code: `EMP-9${String(i).padStart(3, '0')}`, email: `bulk${i}@delta.test`, name: `Zz Bulk ${String(i).padStart(2, '0')}`, managerId: null };
      });
      await mod.db().employees.insertMany(extra);
      try {
        const hr = await as('HR');
        const total = await mod.db().employees.countDocuments();
        const first = (await hr.get<Page<EmployeeRow>>('/employees')).body;
        const second = (await hr.get<Page<EmployeeRow>>('/employees?page=2')).body;
        const last = (await hr.get<Page<EmployeeRow>>('/employees?page=99')).body;
        expect(first.items).toHaveLength(25);
        expect(first.total).toBe(total);
        expect(second.items).toHaveLength(Math.min(25, total - 25));
        expect(last.items).toHaveLength(0);
        expect(new Set([...first.items, ...second.items].map((e) => e.id)).size).toBe(first.items.length + second.items.length);
        expect((await hr.get<Page<EmployeeRow>>('/employees?search=zz+bulk')).body.total).toBe(30);
      } finally {
        await mod.db().employees.deleteMany({ email: /^bulk\d+@delta\.test$/ });
      }
    });
  });

  it('never said a password digest in any answer', async () => {
    // Read the schedules too, so their answers are in the sweep.
    await (await as('HR')).get<ScheduleRow[]>('/schedules');
    expect(everythingAnswered.length).toBeGreaterThan(150);
    for (const text of everythingAnswered) {
      expect(text).not.toContain('scrypt$');
      // A refusal may echo a field name the sender used; what must never appear is the stored field itself.
      expect(text).not.toMatch(/"passwordHash"\s*:/);
    }
  });
});
