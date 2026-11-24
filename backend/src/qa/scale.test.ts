/*
 * QA scale check: the lists and reports with a company of five hundred behind them.
 *
 * The phase tests run against a dozen sample people, where everything is fast. This file
 * fills a database the way a year of real use would (five hundred more people, five weeks of
 * punches, a hundred requests of each kind waiting, twenty thousand lines in the audit log),
 * then asks every list and report for its first page and holds each answer to a time and a
 * size. A list that reads everything to show a page, or a page that is not a page, fails here.
 *
 * The times are generous on purpose: this is a check that nothing grows with the company in
 * a way that hurts, not a benchmark. The numbers it measured are printed with
 * `npm run qa -- --reporter=verbose`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, exampleA, startingEntry, weekdayOf, zonedToInstant, type Announcement, type LeavePolicy, type LeaveType } from '@delta-hrms/shared';
import { boot, Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from '../testkit';

const ZONE = 'Asia/Kolkata';
const TODAY = '2026-12-07'; // a Monday
const LAST_FRIDAY = '2026-12-04';
const PEOPLE = 500;
/** The first hundred report to the sample Manager, and each has a request of both kinds waiting. */
const TEAM = 100;
const AUDIT_LINES = 20_000;
const moment = (date: string, time: string) => zonedToInstant(date, time, ZONE).toISOString();
const pad = (n: number, width: number) => String(n).padStart(width, '0');
const bulkId = (i: number) => `emp_bulk${pad(i, 4)}`;
const bulkEmail = (i: number) => `person${i}@bulk.test`;

const emailByKey = (key: string) => mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.email;
const made = { leaveType: '', policy: '' };

beforeAll(async () => {
  await boot('qa_scale');
  if (!reachable) return;
  mod.clock.setTestNow(moment(TODAY, '10:00'));
  await resetToSample();
  const hr = await signIn(emailByKey('hr'));
  made.leaveType = (await hr.post<LeaveType>('/leave-types', { name: 'Casual leave', code: 'CL', paid: true, allowHalfDay: true, tone: 'blue' })).body.id;
  made.policy = (await hr.post<LeavePolicy>('/leave-policies', { name: 'Standard', approver: 'manager', entries: [{ ...startingEntry(made.leaveType), annualDays: 12, prorateFirstYear: false }] })).body.id;

  // Five hundred more people. They share the sample password, so that some of them can sign in below.
  const now = moment(TODAY, '01:00');
  const admin = await idOf(emailByKey('admin'));
  const manager = await idOf(emailByKey('manager'));
  const departments = (await mod.db().departments.find().toArray()).map((d) => d._id);
  const { passwordHash } = (await mod.db().employees.findOne({ _id: admin }))!;
  const ids = Array.from({ length: PEOPLE }, (_, i) => bulkId(i));
  await mod.db().employees.insertMany(
    ids.map((id, i) => ({
      _id: id,
      code: `EMP-9${pad(i, 3)}`,
      name: `Person ${pad(i, 3)}`,
      email: bulkEmail(i),
      phone: '',
      role: 'Employee' as const,
      departmentId: departments[i % departments.length]!,
      designation: 'Executive',
      managerId: i < TEAM ? manager : admin,
      joinDate: '2025-01-01',
      employment: [{ from: '2026-11-01', to: null }],
      status: 'active' as const,
      leavePolicyId: made.policy,
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
      passwordHash,
    })),
  );
  const rules = exampleA(ZONE);
  await mod.db().scheduleAssignments.insertMany(ids.map((id, i) => ({ _id: `asg_bulk${pad(i, 4)}`, employeeId: id, effectiveFrom: '2026-11-01', scheduleId: null, rules, holidayCalendarId: null, note: '', createdBy: admin, createdByName: 'Anita Menon', createdAt: now })));

  // Five weeks of punches, Monday to Friday. The team has nothing for last Friday: that is what they ask to have corrected.
  const dates: string[] = [];
  for (let date = '2026-11-02'; date <= LAST_FRIDAY; date = addDays(date, 1)) if (!['sat', 'sun'].includes(weekdayOf(date))) dates.push(date);
  await mod.db().attendanceDays.insertMany(
    ids.flatMap((id, i) =>
      dates
        .filter((date) => !(i < TEAM && date === LAST_FRIDAY))
        .map((date, d) => ({
          _id: `${id}|${date}`,
          employeeId: id,
          date,
          assignmentId: `asg_bulk${pad(i, 4)}`,
          checkInAt: moment(date, (i + d) % 7 === 0 ? '09:40' : '09:00'),
          checkOutAt: moment(date, (i + d) % 11 === 0 ? '13:30' : '18:00'),
          breaks: [],
          override: null,
          lateExcused: false,
          note: null,
          history: [],
          version: 1,
          createdAt: now,
          updatedAt: now,
        })),
    ),
  );

  // A hundred requests of each kind, sent by the people themselves, ten at a time.
  for (let start = 0; start < TEAM; start += 10) {
    await Promise.all(
      Array.from({ length: 10 }, async (_, k) => {
        const i = start + k;
        const client = await signIn(bulkEmail(i));
        const leave = await client.post('/leave/requests', { leaveTypeId: made.leaveType, startDate: addDays(TODAY, 7 + (i % 5)), endDate: addDays(TODAY, 7 + (i % 5)), dayPart: 'full', reason: 'A family function' });
        const correction = await client.post('/regularizations', { date: LAST_FRIDAY, type: 'forgot_attendance', checkIn: `${LAST_FRIDAY}T09:00`, checkOut: `${LAST_FRIDAY}T18:00`, status: null, reason: 'I forgot to check in and out' });
        expect([leave.status, correction.status], bulkEmail(i)).toEqual([201, 201]);
      }),
    );
  }

  // Three hundred announcements: one made through the API, the rest copies of it.
  const posted = await hr.post<Announcement>('/announcements', { title: 'Office closed on Friday', body: 'The office is closed for maintenance.', importance: 'normal', pinned: false, startsAt: null, expiresAt: null, audience: { kind: 'all' } });
  expect(posted.status).toBe(201);
  const stored = (await mod.db().announcements.findOne({ _id: posted.body.id }))!;
  await mod.db().announcements.insertMany(Array.from({ length: 299 }, (_, i) => ({ ...stored, _id: `ann_bulk${pad(i, 4)}`, title: `Notice ${pad(i, 3)}`, startsAt: moment(addDays(TODAY, -1 - (i % 60)), '09:00') })));

  // A year's worth of audit log: twenty thousand lines over the last two months.
  const hrId = await idOf(emailByKey('hr'));
  const actions = ['attendance.corrected', 'leave.adjusted', 'schedule.assigned', 'employee.created', 'holiday.created', 'report.exported'];
  for (let start = 0; start < AUDIT_LINES; start += 5000) {
    await mod.db().audit.insertMany(
      Array.from({ length: 5000 }, (_, k) => {
        const n = start + k;
        return {
          _id: `aud_bulk${pad(n, 6)}`,
          at: new Date(Date.parse(moment(TODAY, '00:00')) - (n + 1) * 240_000).toISOString(),
          actor: n % 3 === 0 ? { id: admin, name: 'Anita Menon', role: 'Admin' as const } : { id: hrId, name: 'Rahul Nair', role: 'HR' as const },
          action: actions[n % actions.length]!,
          targetType: 'employee',
          targetId: bulkId(n % PEOPLE),
          employeeId: bulkId(n % PEOPLE),
          summary: `Line ${n} about Person ${pad(n % PEOPLE, 3)}.`,
          after: { note: 'Filled in by the scale check.' },
        };
      }),
    );
  }
}, 180_000);
afterAll(shutdown);

interface Paged {
  items: unknown[];
  total: number;
  pageSize: number;
}

describe.skipIf(!reachable)('QA scale check: five hundred people', () => {
  const measured: string[] = [];
  /** Asks twice and keeps the slower answer, so one lucky run does not pass a slow list. */
  async function timed<T>(client: Client, path: string, limitMs: number, csv = false) {
    let slowest = 0;
    let answer!: { status: number; body: T; text: string };
    for (let run = 0; run < 2; run += 1) {
      const started = performance.now();
      const got = csv ? await client.text(path) : await client.get<T>(path);
      slowest = Math.max(slowest, performance.now() - started);
      answer = { status: got.status, body: (got as { body: T }).body, text: csv ? (got as { text: string }).text : JSON.stringify((got as { body: T }).body) };
    }
    measured.push(`${pad(Math.round(slowest), 5)} ms  ${pad(Math.round(answer.text.length / 1024), 5)} KB  ${path}`);
    expect(answer.status, path).toBe(200);
    expect(slowest, `${path} took ${Math.round(slowest)} ms`).toBeLessThan(limitMs);
    return answer;
  }
  /** A paged list: the page is a page however much is behind it. */
  async function page(client: Client, path: string, size: number, atLeast: number, limitMs = 1500) {
    const { body } = await timed<Paged>(client, path, limitMs);
    expect(body.pageSize, path).toBe(size);
    expect(body.items.length, path).toBeLessThanOrEqual(size);
    expect(body.total, path).toBeGreaterThanOrEqual(atLeast);
    return body;
  }

  it('was filled as described', async () => {
    expect(await mod.db().employees.countDocuments()).toBeGreaterThanOrEqual(PEOPLE + 10);
    expect(await mod.db().attendanceDays.countDocuments()).toBe(PEOPLE * 25 - TEAM);
    expect(await mod.db().leaveRequests.countDocuments({ status: 'pending' })).toBe(TEAM);
    expect(await mod.db().corrections.countDocuments({ status: 'pending' })).toBe(TEAM);
    expect(await mod.db().announcements.countDocuments()).toBe(300);
    expect(await mod.db().audit.countDocuments()).toBeGreaterThanOrEqual(AUDIT_LINES + 2 * TEAM);
  });

  it('every paged list answers with one page, quickly', async () => {
    const hr = await signIn(emailByKey('hr'));
    const admin = await signIn(emailByKey('admin'));
    const manager = await signIn(emailByKey('manager'));

    await page(hr, '/employees', 25, PEOPLE);
    await page(hr, '/employees?page=20', 25, PEOPLE);
    await page(hr, '/employees?search=Person%20049', 25, 1);
    const team = await page(manager, '/employees?team=1', 25, TEAM);
    expect(team.total).toBeLessThan(PEOPLE);

    await page(manager, '/leave/requests?view=inbox', 20, TEAM);
    await page(hr, '/leave/requests?view=inbox', 20, TEAM);
    await page(manager, '/regularizations?view=inbox', 20, TEAM);
    await page(hr, '/regularizations?view=inbox', 20, TEAM);
    await page(hr, '/leave/requests?view=decided', 20, 0);

    // What is showing for one person is not paged: it stops at the hundred that come first.
    const feed = await timed<{ items: unknown[]; unread: number }>(hr, '/announcements', 1500);
    expect([feed.body.items.length, feed.body.unread]).toEqual([100, 100]);
    await page(hr, '/announcements/manage', 20, 300);
    await page(hr, '/announcements/manage?page=15', 20, 300);

    await page(hr, `/attendance/records?from=2026-11-16&to=${LAST_FRIDAY}`, 50, PEOPLE * 10, 4000);
    await page(hr, `/attendance/records?from=2026-11-30&to=${LAST_FRIDAY}&flag=late`, 50, 100);

    await page(admin, '/audit', 50, AUDIT_LINES);
    await page(admin, '/audit?page=300', 50, AUDIT_LINES);
    await page(admin, '/audit?area=leave', 50, 3000);
    await page(admin, '/audit?search=Person%20049', 50, 40);
    await page(admin, `/audit?employeeId=${bulkId(7)}`, 50, 40);
    await page(admin, `/audit?from=${addDays(TODAY, -7)}&to=${TODAY}`, 50, 2000);
  });

  it('the pages that read everyone answer in time', async () => {
    const hr = await signIn(emailByKey('hr'));
    const manager = await signIn(emailByKey('manager'));

    const overview = await timed<{ counts: { all: number }; people: Paged }>(hr, `/dashboard/hr?date=${LAST_FRIDAY}`, 2500);
    expect(overview.body.counts.all).toBeGreaterThanOrEqual(PEOPLE);
    expect(overview.body.people.items.length).toBeLessThanOrEqual(50);
    const hers = await timed<{ counts: { all: number } }>(manager, `/dashboard/hr?date=${LAST_FRIDAY}`, 2500);
    expect(hers.body.counts.all).toBeLessThan(PEOPLE);

    const month = await timed<{ rows: unknown[] }>(hr, '/reports/monthly?month=2026-11', 6000);
    expect(month.body.rows.length).toBeGreaterThanOrEqual(PEOPLE);
    const file = await timed<never>(hr, '/reports/monthly?month=2026-11&format=csv', 6000, true);
    expect(file.text.split('\r\n').length).toBeGreaterThan(PEOPLE);

    // The lists a form fills its choices from: everyone, but a line each.
    const picker = await timed<unknown[]>(hr, '/employees/picker', 1500);
    expect(picker.text.length / PEOPLE).toBeLessThan(400);
    await timed(hr, '/reports/people', 1500);
    await timed(hr, '/schedules', 1500);
    await timed(hr, '/holiday-calendars', 1500);
    await timed(hr, '/leave-policies', 1500);
    await timed(hr, '/departments', 1500);
  });

  it('one person’s own pages do not slow down as the company grows', async () => {
    const one = await signIn(bulkEmail(7));
    await timed(one, '/me', 800);
    await timed(one, '/dashboard/me', 1000);
    await timed(one, '/attendance/today', 800);
    await timed(one, '/attendance/calendar?month=2026-11', 800);
    await timed(one, '/leave/balances', 800);
    await timed(one, '/leave/requests', 800);
    await timed(one, '/regularizations', 800);
    await timed(one, '/announcements', 800);
    await timed(one, '/holidays/mine', 800);
    await timed(one, `/reports/employee/${bulkId(7)}?from=2026-11-01&to=2026-11-30`, 800);

    const manager = await signIn(emailByKey('manager'));
    await timed(manager, '/me', 800);
    await timed(manager, '/dashboard/me', 1500);
  });

  it('reads a page of the audit log from its index, not from the whole log', async () => {
    const plan = await mod.db().audit.find({}).sort({ at: -1, _id: -1 }).limit(50).explain('executionStats');
    const stats = (plan as unknown as { executionStats: { totalDocsExamined: number } }).executionStats;
    expect(stats.totalDocsExamined).toBeLessThan(500);
    const days = await mod.db().attendanceDays.find({ employeeId: bulkId(7), date: { $gte: '2026-11-01', $lte: '2026-11-30' } }).explain('executionStats');
    expect((days as unknown as { executionStats: { totalDocsExamined: number } }).executionStats.totalDocsExamined).toBeLessThanOrEqual(31);
  });

  it('prints what it measured', () => {
    console.info(`[scale] ${PEOPLE} more people, slowest of two runs each:\n${measured.sort().reverse().join('\n')}`);
    expect(measured.length).toBeGreaterThan(40);
  });
});
