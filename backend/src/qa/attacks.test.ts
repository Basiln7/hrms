/*
 * QA attack checks: the API used the way someone would who wants what is not theirs.
 *
 * Each group is one kind of attempt, tried across the API rather than on one route:
 * other people's ids, a role or an owner slipped into a body, HR acting on their own record,
 * the same request sent many times at once, input that tries to be more than data, sessions
 * that should have ended, and the audit log itself.
 *
 * The phase tests check each feature in depth. This file is the sweep across them, and the
 * place a new kind of attempt is added.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, OWN_RECORD_MESSAGE, PASSWORD_CHANGE_REQUIRED, startingEntry, zonedToInstant, type Announcement, type AssignmentResult, type AuditListPayload, type EmployeeRow, type ErrorPayload, type HolidayCalendar, type LeaveBalancesPayload, type LeavePolicy, type LeaveRequest, type LeaveType, type MePayload, type Page, type TemporaryPasswordPayload } from '@delta-hrms/shared';
import { baseUrl, boot, Client, everythingAnswered, idOf, mod, reachable, resetToSample, shutdown, signIn } from '../testkit';

const ZONE = 'Asia/Kolkata';
const MON = '2026-12-07';
const TUE = addDays(MON, 1);
const NOBODY = 'emp_000000000000';
const setNow = (date: string, time: string) => mod.clock.setTestNow(zonedToInstant(date, time, ZONE).toISOString());

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
/** A request sent as raw text, for bodies and headers a well-behaved client would never send. */
const raw = (client: Client, method: string, path: string, body: string, headers: Record<string, string> = {}) => fetch(baseUrl() + path, { method, headers: { 'Content-Type': 'application/json', cookie: client.cookie, ...headers }, body });
const tally = (statuses: number[]) => Object.fromEntries([...new Set(statuses)].sort().map((status) => [status, statuses.filter((s) => s === status).length]));

/** What the checks need to exist: made once, by HR and the Admin, through the API. */
const made = { leaveType: '', policy: '', calendar: '', schedule: '', managersOnly: '', divyaLeave: '', temporaryPassword: '' };

beforeAll(async () => {
  await boot('qa_attacks');
  if (!reachable) return;
  setNow(MON, '08:00');
  await resetToSample();
  const hr = await person('hr');
  made.leaveType = (await hr.post<LeaveType>('/leave-types', { name: 'Casual leave', code: 'CL', paid: true, allowHalfDay: true, tone: 'blue' })).body.id;
  made.policy = (await hr.post<LeavePolicy>('/leave-policies', { name: 'Standard', approver: 'manager', entries: [{ ...startingEntry(made.leaveType), annualDays: 12, prorateFirstYear: false }] })).body.id;
  await hr.post('/leave-policies/assign', { policyId: made.policy, employeeIds: await Promise.all(['employee', 'divya', 'manager', 'joseph'].map(idByKey)) });
  await (await person('admin')).post('/leave-policies/assign', { policyId: made.policy, employeeIds: [await idByKey('hr')] });
  made.calendar = (await hr.post<HolidayCalendar>('/holiday-calendars', { name: 'India' })).body.id;
  made.schedule = (await mod.db().schedules.findOne({ name: 'General 9 to 6' }))!._id;
  made.managersOnly = (await hr.post<Announcement>('/announcements', { title: 'For managers only', body: 'Not for everyone.', importance: 'normal', pinned: false, startsAt: null, expiresAt: null, audience: { kind: 'roles', roles: ['Manager'] } })).body.id;
  made.divyaLeave = (await (await person('divya')).post<LeaveRequest>('/leave/requests', { leaveTypeId: made.leaveType, startDate: '2026-12-14', endDate: '2026-12-14', dayPart: 'full', reason: 'A family function' })).body.id;
  expect(Object.values({ ...made, temporaryPassword: 'x' }).every(Boolean)).toBe(true);
});
afterAll(shutdown);

describe.skipIf(!reachable)('QA attack checks', () => {
  describe('other people’s ids', () => {
    /** Everything that can be asked about one person by id. */
    const about = (id: string) => [`/employees/${id}`, `/employees/${id}/schedule`, `/attendance/calendar?employeeId=${id}`, `/attendance/days/${id}/${MON}`, `/leave/balances?employeeId=${id}`, `/leave/requests?view=person&employeeId=${id}`, `/reports/employee/${id}`, `/reports/employee/${id}?format=csv`];

    it('answers for someone the caller may not see exactly as for someone who does not exist', async () => {
      const cases: [viewer: string, target: string][] = [
        ['employee', 'divya'], // a colleague
        ['employee', 'manager'], // their own manager
        ['employee', 'admin'],
        ['manager', 'joseph'], // someone outside her team
        ['manager', 'hr'],
        ['lead', 'employee'], // in his manager's team, not in his
      ];
      for (const [viewer, target] of cases) {
        const client = await person(viewer);
        const theirs = about(await idByKey(target));
        const nobodys = about(NOBODY);
        for (const [index, path] of theirs.entries()) {
          const real = await client.get<ErrorPayload>(path);
          const none = await client.get<ErrorPayload>(nobodys[index]!);
          expect([real.status, real.body], `${viewer} asking ${path}`).toEqual([404, none.body]);
          expect(none.status).toBe(404);
        }
      }
    });

    it('still answers the same questions about the caller themself, and about those they may see', async () => {
      for (const [viewer, target] of [
        ['employee', 'employee'],
        ['manager', 'employee'],
        ['hr', 'joseph'],
      ] as const) {
        const client = await person(viewer);
        for (const path of about(await idByKey(target))) {
          const answer = path.endsWith('format=csv') ? await client.text(path) : await client.get(path);
          expect(answer.status, `${viewer} asking ${path}`).toBe(200);
        }
      }
    });

    it('treats someone else’s request or announcement as one that does not exist', async () => {
      const arjun = await person('employee');
      const pairs: [method: 'get' | 'post', theirs: string, nobodys: string, body?: unknown][] = [
        ['post', `/leave/requests/${made.divyaLeave}/cancel`, '/leave/requests/lvr_000000000000/cancel', {}],
        ['post', `/leave/requests/${made.divyaLeave}/approve`, '/leave/requests/lvr_000000000000/approve', { note: '' }],
        ['post', `/leave/requests/${made.divyaLeave}/reject`, '/leave/requests/lvr_000000000000/reject', { note: 'No' }],
        ['get', `/announcements/${made.managersOnly}`, '/announcements/ann_000000000000'],
        ['post', `/announcements/${made.managersOnly}/read`, '/announcements/ann_000000000000/read', {}],
      ];
      for (const [method, theirs, nobodys, body] of pairs) {
        const real = method === 'get' ? await arjun.get<ErrorPayload>(theirs) : await arjun.post<ErrorPayload>(theirs, body);
        const none = method === 'get' ? await arjun.get<ErrorPayload>(nobodys) : await arjun.post<ErrorPayload>(nobodys, body);
        expect([real.status, real.body], theirs).toEqual([404, none.body]);
      }
      expect((await mod.db().leaveRequests.findOne({ _id: made.divyaLeave }))!.status).toBe('pending');
      expect(await mod.db().announcementReads.countDocuments()).toBe(0);
    });
  });

  describe('a role, an owner or a result slipped into the body', () => {
    it('refuses a body that names anyone or anything the route does not ask for', async () => {
      const arjun = await person('employee');
      const divya = await idByKey('divya');
      const leave = { leaveTypeId: made.leaveType, startDate: '2026-12-15', endDate: '2026-12-15', dayPart: 'full', reason: 'A family function' };
      const attempts: [path: string, body: unknown, method?: 'patch'][] = [
        ['/me/profile', { phone: '123', role: 'Admin' }, 'patch'],
        ['/me/profile', { phone: '123', id: await idByKey('admin') }, 'patch'],
        ['/me/profile', { phone: '123', mustChangePassword: false, status: 'active' }, 'patch'],
        ['/leave/requests', { ...leave, employeeId: divya }],
        ['/leave/requests', { ...leave, status: 'approved' }],
        ['/leave/requests', { ...leave, days: 0, charged: [] }],
        ['/leave/requests/preview', { leaveTypeId: made.leaveType, startDate: '2026-12-15', endDate: '2026-12-15', dayPart: 'full', employeeId: divya }],
        ['/regularizations', { date: MON, type: 'forgot_attendance', checkIn: `${MON}T09:00`, checkOut: `${MON}T18:00`, status: null, reason: 'Forgot', employeeId: divya }],
        ['/attendance/check-in', { at: '2026-12-07T03:00:00.000Z' }],
        ['/attendance/check-in', { employeeId: divya }],
        ['/attendance/check-out', { date: MON }],
      ];
      for (const [path, body, method] of attempts) {
        const answer = method === 'patch' ? await arjun.patch(path, body) : await arjun.post(path, body);
        expect(answer.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      }
      expect((await arjun.get<MePayload>('/me')).body.employee).toMatchObject({ role: 'Employee', phone: '' });
      expect(await mod.db().leaveRequests.countDocuments({ employeeId: await idByKey('employee') })).toBe(0);
      expect(await mod.db().attendanceDays.countDocuments()).toBe(0);
    });

    it('does not let anyone hand out a role they may not, to themselves or to others', async () => {
      const hr = await person('hr');
      const arjun = (await hr.get<EmployeeRow>(`/employees/${await idByKey('employee')}`)).body;
      const details = { name: arjun.name, email: arjun.email, phone: arjun.phone, departmentId: arjun.departmentId, designation: arjun.designation, managerId: arjun.managerId, joinDate: arjun.joinDate };
      const fresh = { name: 'New Person', email: 'new.person@delta.test', phone: '', departmentId: null, designation: '', managerId: null, joinDate: null, schedule: null };

      // HR may not make an Admin or another HR, by adding or by changing.
      expect((await hr.post('/employees', { ...fresh, role: 'Admin' })).status).toBe(403);
      expect((await hr.post('/employees', { ...fresh, role: 'HR' })).status).toBe(403);
      expect((await hr.patch(`/employees/${arjun.id}`, { ...details, role: 'Admin' })).status).toBe(403);
      expect((await hr.patch(`/employees/${arjun.id}`, { ...details, role: 'HR' })).status).toBe(403);
      // Nor touch an Admin's account at all.
      const admin = (await hr.get<EmployeeRow>(`/employees/${await idByKey('admin')}`)).body;
      expect((await hr.patch(`/employees/${admin.id}`, { name: 'Renamed', email: admin.email, phone: '', role: 'Employee', departmentId: admin.departmentId, designation: '', managerId: null, joinDate: null })).status).toBe(403);
      expect((await hr.post(`/employees/${admin.id}/reset-password`)).status).toBe(403);
      // A Manager and an Employee change nobody.
      for (const key of ['manager', 'employee']) {
        expect((await (await person(key)).patch(`/employees/${arjun.id}`, { ...details, role: 'Manager' })).status, key).toBe(403);
        expect((await (await person(key)).post('/employees', { ...fresh, role: 'Employee' })).status, key).toBe(403);
      }
      // The only Admin cannot stop being one.
      const anita = await person('admin');
      const demoted = await anita.patch<ErrorPayload>(`/employees/${admin.id}`, { name: admin.name, email: admin.email, phone: '', role: 'Employee', departmentId: admin.departmentId, designation: admin.designation, managerId: null, joinDate: null });
      expect([403, 409]).toContain(demoted.status);

      expect((await mod.db().employees.find({}, { projection: { role: 1 } }).toArray()).filter((e) => e.role === 'Admin')).toHaveLength(1);
      expect((await mod.db().employees.findOne({ _id: arjun.id }))!.role).toBe('Employee');
      expect(await mod.db().employees.countDocuments({ email: 'new.person@delta.test' })).toBe(0);
    });
  });

  describe('HR acting on their own record', () => {
    it('is refused, or left out of a bulk action, by every route that could change it', async () => {
      const hr = await person('hr');
      const me = await idByKey('hr');
      const mine = (await hr.get<EmployeeRow>(`/employees/${me}`)).body;

      // Bulk actions leave the caller out and say why.
      const bulk: [path: string, body: unknown][] = [
        ['/schedule-assignments', { employeeIds: [me], scheduleId: made.schedule, rules: null, effectiveFrom: TUE, note: '' }],
        ['/holiday-calendars/assign', { calendarId: made.calendar, employeeIds: [me], effectiveFrom: TUE }],
        ['/leave-policies/assign', { policyId: null, employeeIds: [me] }],
      ];
      for (const [path, body] of bulk) {
        const answer = await hr.post<AssignmentResult>(path, body);
        expect([answer.status, answer.body.assigned, answer.body.skipped.map((s) => s.reason)], path).toEqual([200, [], [OWN_RECORD_MESSAGE]]);
      }
      // Single actions are refused.
      const single: [method: 'post' | 'patch' | 'put', path: string, body: unknown][] = [
        ['post', '/leave/adjustments', { employeeId: me, leaveYear: 2026, leaveTypeId: made.leaveType, days: 5, note: 'I worked the weekend' }],
        ['put', `/attendance/days/${me}/${MON}/note`, { text: 'Was at a client' }],
        ['post', `/attendance/days/${me}/${MON}/correct`, { checkIn: `${MON}T09:00`, checkOut: null, override: null, lateExcused: false, reason: 'Forgot to check in', dayVersion: 0 }],
        ['patch', `/employees/${me}`, { name: mine.name, email: mine.email, phone: '', role: 'HR', departmentId: mine.departmentId, designation: 'Head of HR', managerId: null, joinDate: null }],
      ];
      for (const [method, path, body] of single) {
        const answer = await hr.send<ErrorPayload>(method.toUpperCase(), path, body);
        expect([answer.status, answer.body.error], path).toEqual([403, OWN_RECORD_MESSAGE]);
      }
      // Two things nobody may do to their own account, whatever their role, each refused in its own words.
      const off = await hr.post<ErrorPayload>(`/employees/${me}/status`, { status: 'inactive', lastWorkingDay: MON });
      expect([off.status, off.body.error]).toEqual([400, 'You cannot deactivate your own account.']);
      const reset = await hr.post<ErrorPayload>(`/employees/${me}/reset-password`);
      expect([reset.status, reset.body.error]).toEqual([400, 'Change your own password from My profile.']);
      // Their own leave is someone else's to decide.
      const own = await hr.post<LeaveRequest>('/leave/requests', { leaveTypeId: made.leaveType, startDate: '2026-12-16', endDate: '2026-12-16', dayPart: 'full', reason: 'A day for myself' });
      expect(own.status).toBe(201);
      expect((await hr.post(`/leave/requests/${own.body.id}/approve`, { note: '' })).status).toBe(403);
      expect((await hr.post(`/leave/requests/${own.body.id}/reject`, { note: 'No' })).status).toBe(403);

      // Nothing about them changed.
      expect(await mod.db().employees.findOne({ _id: me })).toMatchObject({ designation: mine.designation, status: 'active', leavePolicyId: made.policy, mustChangePassword: false });
      expect((await hr.get<LeaveBalancesPayload>('/leave/balances')).body.rows[0]!.balance).toMatchObject({ adjusted: 0, held: 1 });
      expect(await mod.db().attendanceDays.countDocuments({ employeeId: me })).toBe(0);
      expect(await mod.db().scheduleAssignments.countDocuments({ employeeId: me })).toBe(1);
    });
  });

  describe('the same request, many times at once', () => {
    it('checks a person in once and out once', async () => {
      setNow(MON, '09:00');
      const joseph = await person('joseph');
      expect(tally((await Promise.all(Array.from({ length: 12 }, () => joseph.post('/attendance/check-in')))).map((a) => a.status))).toEqual({ 200: 1, 409: 11 });
      setNow(MON, '18:00');
      expect(tally((await Promise.all(Array.from({ length: 12 }, () => joseph.post('/attendance/check-out')))).map((a) => a.status))).toEqual({ 200: 1, 409: 11 });
      const day = (await mod.db().attendanceDays.findOne({ employeeId: await idByKey('joseph'), date: MON }))!;
      expect(day.history.map((entry) => entry.kind)).toEqual(['check_in', 'check_out']);
    });

    it('holds a leave request once, decides it once, and cancels it once', async () => {
      const arjun = await person('employee');
      const body = { leaveTypeId: made.leaveType, startDate: '2026-12-17', endDate: '2026-12-17', dayPart: 'full', reason: 'A family function' };
      const sent = await Promise.all(Array.from({ length: 12 }, () => arjun.post<LeaveRequest>('/leave/requests', body)));
      expect(tally(sent.map((a) => a.status))).toEqual({ 201: 1, 422: 11 });
      const request = sent.find((a) => a.status === 201)!.body;

      // His manager, HR and the Admin all approve at the same instant, four times each.
      const deciders = await Promise.all(['manager', 'hr', 'admin'].map(person));
      const decided = await Promise.all(Array.from({ length: 12 }, (_, i) => deciders[i % 3]!.post(`/leave/requests/${request.id}/approve`, { note: '' })));
      expect(tally(decided.map((a) => a.status))).toEqual({ 200: 1, 409: 11 });
      const account = (await mod.db().leaveAccounts.findOne({ employeeId: await idByKey('employee'), leaveYear: 2026 }))!;
      expect(account.bookings.map((b) => [b.requestId, b.days, b.state])).toEqual([[request.id, 1, 'taken']]);
      expect(await mod.db().audit.countDocuments({ action: 'leave.approved', targetId: request.id })).toBe(1);

      const cancelled = await Promise.all(Array.from({ length: 8 }, () => arjun.post(`/leave/requests/${request.id}/cancel`, {})));
      expect(tally(cancelled.map((a) => a.status))).toEqual({ 200: 1, 409: 7 });
      expect((await mod.db().leaveAccounts.findOne({ employeeId: await idByKey('employee'), leaveYear: 2026 }))!.bookings).toEqual([]);
    });

    it('never takes a balance below zero, however many adjustments arrive together', async () => {
      const hr = await person('hr');
      const joseph = await idByKey('joseph');
      const before = (await hr.get<LeaveBalancesPayload>(`/leave/balances?employeeId=${joseph}`)).body.rows[0]!.balance.available;
      expect(before).toBe(12);
      // Twenty requests to take a day off each. Twelve days are there.
      const taken = await Promise.all(Array.from({ length: 20 }, () => hr.post('/leave/adjustments', { employeeId: joseph, leaveYear: 2026, leaveTypeId: made.leaveType, days: -1, note: 'Taken before the HRMS' })));
      expect(tally(taken.map((a) => a.status))).toEqual({ 201: 12, 422: 8 });
      expect((await hr.get<LeaveBalancesPayload>(`/leave/balances?employeeId=${joseph}`)).body.rows[0]!.balance).toMatchObject({ adjusted: -12, balance: 0, available: 0 });
    });

    it('makes one calendar, one person and one read mark out of many identical requests', async () => {
      const hr = await person('hr');
      const calendars = await Promise.all(Array.from({ length: 10 }, () => hr.post('/holiday-calendars', { name: 'Dubai office' })));
      expect(tally(calendars.map((a) => a.status))).toEqual({ 201: 1, 422: 9 });

      const fresh = { name: 'Tara Bose', email: 'tara.bose@delta.test', phone: '', role: 'Employee', departmentId: null, designation: '', managerId: null, joinDate: null, schedule: null };
      const people = await Promise.all(Array.from({ length: 8 }, () => hr.post('/employees', fresh)));
      expect(tally(people.map((a) => a.status))).toEqual({ 201: 1, 422: 7 });
      expect(await mod.db().employees.countDocuments({ email: fresh.email })).toBe(1);
      const codes = (await mod.db().employees.find({}, { projection: { code: 1 } }).toArray()).map((e) => e.code);
      expect(new Set(codes).size).toBe(codes.length);

      const fatima = await person('manager');
      const reads = await Promise.all(Array.from({ length: 10 }, () => fatima.post(`/announcements/${made.managersOnly}/read`)));
      expect(tally(reads.map((a) => a.status))).toEqual({ 204: 10 });
      expect(await mod.db().announcementReads.countDocuments({ announcementId: made.managersOnly })).toBe(1);
    });
  });

  describe('input that tries to be more than data', () => {
    it('reads an operator, a pattern or a path as the text it is, or refuses it', async () => {
      const hr = await person('hr');
      // An operator where text is expected.
      expect((await new Client().post('/auth/login', { email: { $ne: null }, password: { $ne: null } })).status).toBe(400);
      expect((await new Client().post('/auth/login', { email: ['admin@delta.test'], password: 'x' })).status).toBe(400);
      expect((await hr.get('/employees?search[$regex]=.*')).status).toBe(400);
      expect((await hr.get('/employees?role[$ne]=Admin')).status).toBe(400);
      expect((await hr.get(`/attendance/calendar?employeeId[$gt]=`)).status).toBe(400);
      // A pattern is searched for as the characters it is: it matches nobody, not everybody.
      expect((await hr.get<Page<EmployeeRow>>('/employees?search=.*')).body.total).toBe(0);
      expect((await hr.get<Page<EmployeeRow>>(`/employees?search=${encodeURIComponent('(a+)+$')}`)).body.total).toBe(0);
      expect((await hr.get('/employees?search=%5C')).status).toBe(200);
      expect((await (await person('admin')).get(`/audit?search=${encodeURIComponent('.*(')}`)).status).toBe(200);
      // An id is an id or it is refused; it is never part of a path or a query.
      for (const id of ['..%2F..%2Fetc%2Fpasswd', `emp_${'a'.repeat(300)}`, 'emp_123;drop', '%00', '{"$ne":null}']) {
        const answer = await hr.get(`/employees/${id}`);
        expect([400, 404], id).toContain(answer.status);
      }
    });

    it('refuses a body that is too large, is not JSON, or carries keys that are not fields', async () => {
      const arjun = await person('employee');
      const huge = JSON.stringify({ leaveTypeId: made.leaveType, startDate: MON, endDate: MON, dayPart: 'full', reason: 'x'.repeat(260_000) });
      expect((await raw(arjun, 'POST', '/leave/requests', huge)).status).toBe(413);
      expect((await raw(arjun, 'POST', '/leave/requests', '{"leaveTypeId": ')).status).toBe(400);
      expect((await raw(arjun, 'POST', '/leave/requests', `{"__proto__":{"role":"Admin"},"constructor":{"prototype":{"role":"Admin"}},"leaveTypeId":"${made.leaveType}","startDate":"2026-12-18","endDate":"2026-12-18","dayPart":"full","reason":"A family function"}`)).status).toBe(400);
      expect((await raw(arjun, 'PATCH', '/me/profile', '{"phone":"1","__proto__":{"role":"Admin"}}')).status).toBe(400);
      // Sent as a form, the body is not read at all: the request has no fields.
      expect((await raw(arjun, 'PATCH', '/me/profile', 'phone=123&role=Admin', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(400);
      expect(({} as Record<string, unknown>).role).toBeUndefined();
      expect((await arjun.get<MePayload>('/me')).body.employee).toMatchObject({ role: 'Employee', phone: '' });
    });

    it('refuses a request sent from another site, and a method the route does not offer', async () => {
      const hr = await person('hr');
      const before = await mod.db().holidayCalendars.countDocuments();
      const foreign = await raw(hr, 'POST', '/holiday-calendars', JSON.stringify({ name: 'From elsewhere' }), { Origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      expect(await mod.db().holidayCalendars.countDocuments()).toBe(before);
      // The same request from the app's own address goes through.
      expect((await raw(hr, 'POST', '/holiday-calendars', JSON.stringify({ name: 'From here' }), { Origin: 'http://localhost:5174' })).status).toBe(201);

      const admin = await person('admin');
      for (const [method, path] of [
        ['DELETE', '/audit'],
        ['POST', '/audit'],
        ['PATCH', '/audit/aud_000000000000'],
        ['DELETE', `/employees/${await idByKey('employee')}`],
        ['PUT', '/settings/company'],
        ['DELETE', '/leave/requests/lvr_000000000000'],
      ] as const) {
        expect((await admin.send(method, path, method === 'DELETE' ? undefined : {})).status, `${method} ${path}`).toBe(404);
      }
    });
  });

  describe('sessions that should have ended', () => {
    it('ends with sign-out, with deactivation and with a password reset, and a temporary password opens one door only', async () => {
      // Signing out: the cookie that was valid a moment ago is no longer.
      const kiran = await signIn(emailByKey('kiran'));
      const stolen = new Client();
      stolen.cookie = kiran.cookie;
      expect((await stolen.get('/me')).status).toBe(200);
      expect((await kiran.post('/auth/logout')).status).toBe(204);
      expect((await stolen.get('/me')).status).toBe(401);

      // Deactivation: Sneha is signed in when HR deactivates her.
      const sneha = await signIn(emailByKey('sneha'));
      expect((await sneha.get('/me')).status).toBe(200);
      const hr = await person('hr');
      expect((await hr.post(`/employees/${await idByKey('sneha')}/status`, { status: 'inactive', lastWorkingDay: MON })).status).toBe(200);
      expect((await sneha.get('/me')).status).toBe(401);
      // With the right password she is told why; with a wrong one, nothing about the account.
      expect((await new Client().post('/auth/login', { email: emailByKey('sneha'), password: mod.seed.DEMO_PASSWORD })).status).toBe(403);
      expect((await new Client().post('/auth/login', { email: emailByKey('sneha'), password: 'not-her-password' })).status).toBe(401);

      // A reset: Divya's session ends, her old password stops working, and the temporary one lets her do one thing.
      const divya = await signIn(emailByKey('divya'));
      const reset = await hr.post<TemporaryPasswordPayload>(`/employees/${await idByKey('divya')}/reset-password`);
      expect(reset.status).toBe(200);
      made.temporaryPassword = reset.body.temporaryPassword;
      expect((await divya.get('/me')).status).toBe(401);
      expect((await new Client().post('/auth/login', { email: emailByKey('divya'), password: mod.seed.DEMO_PASSWORD })).status).toBe(401);
      const back = await signIn(emailByKey('divya'), made.temporaryPassword);
      expect((await back.get<MePayload>('/me')).body.employee.mustChangePassword).toBe(true);
      for (const path of ['/employees', '/dashboard/me', '/leave/balances', '/announcements', '/attendance/today']) {
        const refused = await back.get<ErrorPayload>(path);
        expect([refused.status, refused.body.code], path).toEqual([403, PASSWORD_CHANGE_REQUIRED]);
      }
      expect((await back.post('/attendance/check-in')).status).toBe(403);
    });

    it('slows down guessing at a password', async () => {
      const guesses = [];
      for (let i = 0; i < 12; i += 1) guesses.push((await new Client().post('/auth/login', { email: 'guessed@delta.test', password: `guess-${i}` })).status);
      // Ten tries, then a wait. An account that does not exist is answered like a wrong password.
      expect(guesses).toEqual([...Array<number>(10).fill(401), 429, 429]);
      // Claiming to come from somewhere else each time does not start the count again: nobody is believed about their own address.
      const elsewhere = await fetch(`${baseUrl()}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' }, body: JSON.stringify({ email: 'guessed@delta.test', password: 'guess-again' }) });
      expect(elsewhere.status).toBe(429);
      // Someone else signing in from the same address is not held up by it.
      expect((await new Client().post('/auth/login', { email: emailByKey('employee'), password: mod.seed.DEMO_PASSWORD })).status).toBe(204);
    });
  });

  describe('a session someone else got hold of', () => {
    it('cannot be used to find out the password by trying, or to change it without knowing it', async () => {
      const imran = await signIn(emailByKey('imran'));
      const tries = [];
      for (let i = 0; i < 12; i += 1) tries.push((await imran.post('/me/password', { current: `not-it-${i}`, next: 'a-new-password-1' })).status);
      expect(tries).toEqual([...Array<number>(10).fill(403), 429, 429]);
      // The password is what it was, and the session can still do everything else.
      expect((await new Client().post('/auth/login', { email: emailByKey('imran'), password: mod.seed.DEMO_PASSWORD })).status).toBe(204);
      expect((await imran.get('/attendance/today')).status).toBe(200);
      // It does not hold up anyone else changing theirs.
      const lead = await signIn(emailByKey('lead'));
      expect((await lead.post('/me/password', { current: 'not-it', next: 'a-new-password-1' })).status).toBe(403);
    });
  });

  describe('the audit log', () => {
    it('is read by Admins only, newest first, and says who did what to whom', async () => {
      for (const key of ['employee', 'manager', 'hr']) expect((await (await person(key)).get('/audit')).status, key).toBe(403);
      const log = (await (await person('admin')).get<AuditListPayload>('/audit')).body;
      expect(log).toMatchObject({ page: 1, pageSize: 50, timeZone: ZONE });
      expect(log.total).toBeGreaterThan(30);
      expect(log.items.map((row) => row.at)).toEqual([...log.items.map((row) => row.at)].sort().reverse());
      expect(log.actors.map((actor) => actor.name)).toEqual(['Anita Menon', 'Arjun Das', 'Divya Thomas', 'Fatima Khan', 'Rahul Nair']);

      const reset = log.items.find((row) => row.action === 'employee.password.reset')!;
      expect(reset).toMatchObject({ actor: { name: 'Rahul Nair', role: 'HR' }, employeeName: 'Divya Thomas', summary: 'Gave Divya Thomas a new temporary password.' });
      const deactivated = log.items.find((row) => row.action === 'employee.deactivated')!;
      expect(deactivated).toMatchObject({ actor: { name: 'Rahul Nair' }, employeeName: 'Sneha Iyer' });
    });

    it('narrows by part, by who did it, by whom it concerns, by date and by words', async () => {
      const admin = await person('admin');
      const list = async (query: string) => (await admin.get<AuditListPayload>(`/audit${query}`)).body;
      const hr = await idByKey('hr');

      const people = await list('?area=people');
      expect(people.total).toBeGreaterThan(0);
      expect(people.items.every((row) => /^(employee|department)\./.test(row.action))).toBe(true);
      const leave = await list('?area=leave');
      expect(leave.items.every((row) => /^leave(_type|_policy)?\./.test(row.action))).toBe(true);
      expect(leave.items.some((row) => row.action === 'leave.adjusted')).toBe(true);
      expect((await list('?area=schedules')).total).toBe(0);

      const byHr = await list(`?actorId=${hr}`);
      expect(byHr.items.every((row) => row.actor?.id === hr)).toBe(true);
      const aboutDivya = await list(`?employeeId=${await idByKey('divya')}`);
      expect(aboutDivya.items.map((row) => row.action).sort()).toEqual(['employee.password.reset', 'leave.requested', 'leave_policy.assigned']);
      expect((await list('?search=temporary%20password')).items.map((row) => row.action)).toEqual(['employee.password.reset']);
      expect((await list('?search=TEMPORARY')).total).toBe(1);

      const all = (await list('')).total;
      expect((await list(`?from=${MON}&to=${MON}`)).total).toBe(all);
      expect((await list(`?from=${TUE}`)).total).toBe(0);
      expect((await list(`?to=${addDays(MON, -1)}`)).total).toBe(0);
      expect((await list('?page=99')).items).toEqual([]);
      expect((await admin.get('/audit?area=everything')).status).toBe(400);
      expect((await admin.get('/audit?actorId=someone')).status).toBe(400);
    });

    it('holds no password, digest or temporary password, and no row that was changed or removed', async () => {
      expect(made.temporaryPassword.length).toBeGreaterThan(8);
      const rows = await mod.db().audit.find().toArray();
      const text = JSON.stringify(rows);
      expect(text).not.toContain(made.temporaryPassword);
      expect(text).not.toContain(mod.seed.DEMO_PASSWORD);
      expect(text).not.toContain('scrypt$');
      expect(text).not.toMatch(/passwordHash/);
      // Every refused attempt above left the log as it was: rows are only ever added.
      expect(new Set(rows.map((row) => row._id)).size).toBe(rows.length);
      expect(rows.every((row) => typeof row.at === 'string' && row.summary.length > 0)).toBe(true);
    });
  });

  it('never said a password digest in any answer, and the temporary password only once, to the person who asked for it', () => {
    expect(everythingAnswered.length).toBeGreaterThan(300);
    const all = everythingAnswered.join('\n');
    expect(all).not.toContain('scrypt$');
    expect(all).not.toMatch(/"passwordHash"\s*:/);
    expect(all.split(made.temporaryPassword).length - 1).toBe(1);
    expect(all).not.toContain(mod.seed.DEMO_PASSWORD);
  });
});
