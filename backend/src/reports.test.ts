/*
 * End-to-end tests of the overview, the attendance records and the reports (Phase 9) against
 * a real MongoDB. The clock is set by the tests and only moves forward through the file: a
 * Monday of punches, a Tuesday morning looked at from every side, a night shift, and at the
 * end a company of five hundred.
 *
 * What a group or a filter means, and how a row is written, is tested in shared. Here it is
 * what the API must hold for every caller: each number is the engine's own count over the
 * people the caller may see; a Manager reaches their team and nobody else; a report says
 * what the calendar says; a file carries the same rows, made safe for a spreadsheet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  countOverview,
  exampleA,
  OVERVIEW_GROUPS,
  startingEntry,
  zonedToInstant,
  type AssignmentResult,
  type AttendanceCalendarPayload,
  type CorrectionRequest,
  type DayResult,
  type EmployeeReportPayload,
  type ErrorPayload,
  type HolidayCalendar,
  type LeavePolicy,
  type LeaveRequest,
  type LeaveType,
  type MonthlyReportPayload,
  type OverviewPayload,
  type RecordsPayload,
  type ReportPerson,
  type ScheduleAssignment,
  type TodayPayload,
} from '@delta-hrms/shared';
import { boot, Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

const ZONE = 'Asia/Kolkata';
const MON = '2026-12-07';
const [TUE, WED, THU] = [addDays(MON, 1), addDays(MON, 2), addDays(MON, 3)];

const moment = (date: string, time: string) => zonedToInstant(date, time, ZONE).toISOString();
const setNow = (date: string, time: string) => mod.clock.setTestNow(moment(date, time));

beforeAll(async () => {
  await boot('reports');
  if (!reachable) return;
  setNow(MON, '05:00');
  await resetToSample();
});
afterAll(shutdown);

const emailByKey = (key: string) => mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.email;
const nameByKey = (key: string) => mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.name;
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
};
/** Punches in the order of the clock: [time, who, in or out]. */
async function punches(date: string, list: [time: string, key: string, action: 'check-in' | 'check-out'][]) {
  for (const [time, key, action] of list) {
    setNow(date, time);
    await punch(key, action);
  }
}

const overviewAs = async (key: string, query = '') => (await person(key)).get<OverviewPayload & ErrorPayload>(`/dashboard/hr${query}`);
const recordsAs = async (key: string, query = '') => (await person(key)).get<RecordsPayload & ErrorPayload>(`/attendance/records${query}`);
const monthlyAs = async (key: string, query = '') => (await person(key)).get<MonthlyReportPayload & ErrorPayload>(`/reports/monthly${query}`);
const employeeAs = async (key: string, of: string, query = '') => (await person(key)).get<EmployeeReportPayload & ErrorPayload>(`/reports/employee/${await idByKey(of)}${query}`);
const monthOf = async (key: string, month = '2026-12') => (await (await person('admin')).get<AttendanceCalendarPayload>(`/attendance/calendar?employeeId=${await idByKey(key)}&month=${month}`)).body;
const namesIn = (payload: { people: { items: { name: string }[] } }) => payload.people.items.map((row) => row.name);
const auditOf = (action: string) => mod.db().audit.find({ action }).sort({ $natural: 1 }).toArray();
/** A CSV file as rows of cells, read the way a spreadsheet would: quoted cells, doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  return rows;
}

/** Everyone who is not deactivated, by key: thirteen people less Leela, who has left. */
const ACTIVE = ['admin', 'hr', 'manager', 'employee', 'newjoiner', 'lead', 'divya', 'imran', 'sneha', 'joseph', 'nisha', 'kiran'];

describe.skipIf(!reachable)('overview, records and reports', () => {
  it('starts from a Monday of punches, a holiday calendar, one day of leave, and a Tuesday morning', async () => {
    setNow(MON, '06:00');
    const hr = await person('hr');
    // Arjun is put on a holiday calendar from tomorrow, with Christmas on it.
    const calendar = await hr.post<HolidayCalendar>('/holiday-calendars', { name: 'India' });
    await hr.post<AssignmentResult>('/holiday-calendars/assign', { calendarId: calendar.body.id, employeeIds: [await idByKey('employee')], effectiveFrom: TUE });
    expect((await hr.post('/holidays', { calendarId: calendar.body.id, date: '2026-12-25', name: 'Christmas Day', type: 'public', description: '' })).status).toBe(201);
    // Nisha takes Tuesday as unpaid leave, approved by HR.
    const type = await hr.post<LeaveType>('/leave-types', { name: 'Unpaid leave', code: 'LOP', paid: false, allowHalfDay: true, tone: 'slate' });
    const policy = await hr.post<LeavePolicy>('/leave-policies', { name: 'Unpaid only', approver: 'hr', entries: [startingEntry(type.body.id)] });
    await hr.post('/leave-policies/assign', { policyId: policy.body.id, employeeIds: [await idByKey('nisha')] });
    const leave = await (await person('nisha')).post<LeaveRequest>('/leave/requests', { leaveTypeId: type.body.id, startDate: TUE, endDate: TUE, dayPart: 'full', reason: 'A family function' });
    expect((await hr.post(`/leave/requests/${leave.body.id}/approve`, { note: '' })).status).toBe(200);

    await punches(MON, [
      ['09:00', 'employee', 'check-in'], // Arjun: a full day
      ['09:00', 'joseph', 'check-in'], // Joseph: leaves at 13:30, a half-day
      ['09:30', 'manager', 'check-in'], // Fatima: late, a full day
      ['10:00', 'divya', 'check-in'], // Divya (10 to 7): a full day
      ['10:00', 'lead', 'check-in'], // Vivek: never checks out
      ['13:30', 'joseph', 'check-out'],
      ['18:00', 'employee', 'check-out'],
      ['18:30', 'manager', 'check-out'],
      ['19:00', 'divya', 'check-out'],
    ]);
    await punches(TUE, [
      ['08:55', 'hr', 'check-in'],
      ['09:05', 'employee', 'check-in'],
      ['10:00', 'divya', 'check-in'],
      ['10:02', 'lead', 'check-in'],
      ['10:40', 'manager', 'check-in'], // late again
    ]);
    setNow(TUE, '11:00');
  });

  describe('the overview of a day', () => {
    it('is for those who may see reports: an Employee is refused', async () => {
      expect((await overviewAs('employee')).status).toBe(403);
      expect((await recordsAs('employee')).status).toBe(403);
      expect((await monthlyAs('employee')).status).toBe(403);
      expect((await (await person('employee')).get('/reports/people')).status).toBe(403);
    });

    it('counts today for everyone, each person in exactly one group', async () => {
      const today = (await overviewAs('hr')).body;
      expect(today).toMatchObject({ date: TUE, today: TUE, scope: 'all', filter: 'all' });
      expect(today.counts).toEqual({
        all: 12,
        checked_in: 5,
        late: 1,
        working: 5, // Rahul, Arjun, Divya, Vivek, Fatima
        present: 0,
        half_day: 0,
        absent: 3, // Joseph, Imran and Anita should be in by now and are not
        unresolved: 0,
        leave: 1, // Nisha
        day_off: 0,
        not_due: 1, // Sneha's hours are flexible
        upcoming: 0,
        not_counted: 2, // Kiran has no schedule; Meera's starts next week
      });
      expect(OVERVIEW_GROUPS.reduce((sum, group) => sum + today.counts[group], 0)).toBe(today.counts.all);
      // Leela has left: she is not among today's people.
      expect(namesIn(today)).toEqual(ACTIVE.map(nameByKey).sort());
      expect(today.people).toMatchObject({ total: 12, page: 1 });
    });

    it('every dashboard number equals the engine’s count over the same people', async () => {
      for (const date of [MON, TUE]) {
        const index = Number(date.slice(8, 10)) - 1;
        const days: DayResult[] = [];
        for (const key of ACTIVE) days.push((await monthOf(key)).days[index]!);
        expect((await overviewAs('hr', `?date=${date}`)).body.counts, date).toEqual(countOverview(days));
      }
      // Monday, read on Tuesday: three full days, a half-day, one never checked out, five who did not come.
      expect((await overviewAs('hr', `?date=${MON}`)).body.counts).toMatchObject({ all: 12, present: 3, half_day: 1, unresolved: 1, absent: 5, not_counted: 2, working: 0, late: 1, checked_in: 5 });
    });

    it('opens the list behind each number, and finds a person by name or code', async () => {
      const absent = (await overviewAs('hr', '?filter=absent')).body;
      expect(absent.filter).toBe('absent');
      expect(namesIn(absent)).toEqual(['Anita Menon', 'Imran Sheikh', 'Joseph Mathew']);
      expect(absent.people.items.map((row) => row.day.status)).toEqual(['not_in', 'not_in', 'not_in']);
      // The numbers stay those of everyone in view: only the list is narrowed.
      expect(absent.counts.all).toBe(12);

      const late = (await overviewAs('hr', '?filter=late')).body.people.items;
      expect(late.map((row) => [row.name, row.day.lateMinutes, row.scheduleName, row.timeZone])).toEqual([['Fatima Khan', 100, 'General 9 to 6', ZONE]]);
      expect(namesIn((await overviewAs('hr', '?filter=leave')).body)).toEqual(['Nisha Varma']);
      expect((await overviewAs('hr', '?filter=leave')).body.people.items[0]!.day.leave).toMatchObject({ name: 'Unpaid leave' });
      expect(namesIn((await overviewAs('hr', '?filter=checked_in')).body)).toEqual(['Arjun Das', 'Divya Thomas', 'Fatima Khan', 'Rahul Nair', 'Vivek Sharma']);
      expect(namesIn((await overviewAs('hr', '?search=JOS')).body)).toEqual(['Joseph Mathew']);
      expect(namesIn((await overviewAs('hr', '?search=emp-0004')).body)).toEqual(['Arjun Das']);
      expect(namesIn((await overviewAs('hr', '?filter=working&search=a')).body)).toEqual(['Arjun Das', 'Divya Thomas', 'Fatima Khan', 'Rahul Nair', 'Vivek Sharma']);
      expect((await overviewAs('hr', '?filter=everyone')).status).toBe(400);
      expect((await overviewAs('hr', '?page=2')).body.people.items).toEqual([]);
    });

    it('filters by department and by manager', async () => {
      const sales = (await mod.db().departments.findOne({ name: 'Sales' }))!._id;
      const inSales = (await overviewAs('hr', `?departmentId=${sales}`)).body;
      expect(namesIn(inSales)).toEqual(['Arjun Das', 'Divya Thomas', 'Fatima Khan', 'Imran Sheikh', 'Meera Pillai', 'Vivek Sharma']);
      expect(inSales.counts).toMatchObject({ all: 6, working: 4, absent: 1, not_counted: 1 });
      // Vivek's team: Divya and Imran.
      const underVivek = (await overviewAs('hr', `?managerId=${await idByKey('lead')}`)).body;
      expect(namesIn(underVivek)).toEqual(['Divya Thomas', 'Imran Sheikh']);
      expect(underVivek.counts).toMatchObject({ all: 2, working: 1, absent: 1 });
      // Fatima's: her own reports and, through Vivek, his.
      expect((await overviewAs('hr', `?managerId=${await idByKey('manager')}`)).body.counts.all).toBe(5);
      expect((await overviewAs('hr', `?managerId=${await idByKey('manager')}&departmentId=${sales}&filter=absent`)).body.people.total).toBe(1);
      expect((await overviewAs('hr', '?managerId=emp_000000000000')).status).toBe(404);
    });

    it('a Manager’s numbers cover only their chain', async () => {
      const mine = (await overviewAs('manager')).body;
      expect(mine.scope).toBe('team');
      // Fatima's team is five people. She is not one of them, and neither is anyone in Operations or Support.
      expect(namesIn(mine)).toEqual(['Arjun Das', 'Divya Thomas', 'Imran Sheikh', 'Meera Pillai', 'Vivek Sharma']);
      expect(mine.counts).toMatchObject({ all: 5, working: 3, absent: 1, not_counted: 1, leave: 0, late: 0 });
      // She may narrow it to Vivek's team, which is part of hers; not to Nisha's, nor to someone outside it.
      expect(namesIn((await overviewAs('manager', `?managerId=${await idByKey('lead')}`)).body)).toEqual(['Divya Thomas', 'Imran Sheikh']);
      expect((await overviewAs('manager', `?managerId=${await idByKey('nisha')}`)).status).toBe(404);
      expect((await overviewAs('manager', `?managerId=${await idByKey('admin')}`)).status).toBe(404);
      // Nisha's team is Kiran alone (Leela has left); Vivek's is two.
      expect(namesIn((await overviewAs('nisha')).body)).toEqual(['Kiran Babu']);
      expect((await overviewAs('lead')).body.counts.all).toBe(2);
      // A search cannot reach past the team either.
      expect((await overviewAs('manager', '?search=Joseph')).body.people.total).toBe(0);
    });

    it('My team shows each person’s status today, and no other list carries it', async () => {
      type TeamRow = { name: string; today?: { day: DayResult; timeZone: string } };
      const team = (await (await person('manager')).get<{ items: TeamRow[] }>('/employees?team=1')).body.items;
      expect(team.map((row) => [row.name, row.today?.day.status, row.today?.day.date])).toEqual([
        ['Arjun Das', 'working', TUE],
        ['Divya Thomas', 'working', TUE],
        ['Imran Sheikh', 'not_in', TUE],
        ['Meera Pillai', 'not_applicable', TUE],
        ['Vivek Sharma', 'working', TUE],
      ]);
      expect(team[0]!.today).toMatchObject({ timeZone: ZONE, day: { checkInAt: moment(TUE, '09:05') } });
      // It is the engine's reading of the same day the overview shows.
      const overviewRows = (await overviewAs('manager')).body.people.items;
      expect(team.map((row) => row.today?.day)).toEqual(overviewRows.map((row) => row.day));
      const everyone = (await (await person('hr')).get<{ items: TeamRow[] }>('/employees')).body.items;
      expect(everyone.every((row) => row.today === undefined)).toBe(true);
    });

    it('says what waits for the caller, and the next holidays of the people in view', async () => {
      // Vivek asks for Monday's missing check-out to be corrected: it waits for his manager, Fatima.
      setNow(TUE, '11:10');
      const asked = await (await person('lead')).post<CorrectionRequest>('/regularizations', { date: MON, type: 'missing_check_out', checkIn: null, checkOut: `${MON}T19:00`, status: null, reason: 'Forgot to check out' });
      expect(asked.status).toBe(201);
      expect((await overviewAs('manager')).body.waiting).toEqual({ leave: 0, corrections: 1 });
      expect((await overviewAs('nisha')).body.waiting).toEqual({ leave: 0, corrections: 0 });
      const vivek = (await overviewAs('manager', `?date=${MON}&filter=unresolved`)).body.people.items[0]!;
      expect([vivek.name, vivek.day.status, [...vivek.day.flags].sort()]).toEqual(['Vivek Sharma', 'unresolved', ['missing_check_out', 'pending_correction']]);
      // Arjun is the one person on a holiday calendar.
      expect((await overviewAs('hr')).body.holidays).toEqual([{ date: '2026-12-25', name: 'Christmas Day', type: 'public', calendarName: 'India' }]);
      expect((await overviewAs('nisha')).body.holidays).toEqual([]);
      expect((await overviewAs('hr', '?date=2026-12-26')).body.holidays).toEqual([]);
    });
  });

  describe('attendance records', () => {
    it('lists everyone’s days of this month so far, newest first, and only days there is something to say about', async () => {
      const list = (await recordsAs('hr')).body;
      expect(list).toMatchObject({ from: '2026-12-01', to: TUE, today: TUE, total: 20, page: 1 });
      // Ten people have a schedule: ten rows for Tuesday, then ten for Monday, each by name.
      expect(list.items.map((row) => row.day.date)).toEqual([...Array<string>(10).fill(TUE), ...Array<string>(10).fill(MON)]);
      expect(list.items.slice(0, 10).map((row) => row.name)).toEqual(['Anita Menon', 'Arjun Das', 'Divya Thomas', 'Fatima Khan', 'Imran Sheikh', 'Joseph Mathew', 'Nisha Varma', 'Rahul Nair', 'Sneha Iyer', 'Vivek Sharma']);
      expect(list.items.find((row) => row.name === 'Joseph Mathew' && row.day.date === MON)).toMatchObject({ code: 'EMP-0010', departmentName: 'Operations', timeZone: ZONE, day: { status: 'half_day', workedMinutes: 270 } });
    });

    it('filters by status, mark, person, department, manager and dates', async () => {
      const names = async (query: string) => (await recordsAs('hr', query)).body.items.map((row) => `${row.name} ${row.day.date.slice(8)}`);
      expect(await names('?status=absent')).toEqual(['Anita Menon 07', 'Imran Sheikh 07', 'Nisha Varma 07', 'Rahul Nair 07', 'Sneha Iyer 07']);
      expect(await names('?status=half_day')).toEqual(['Joseph Mathew 07']);
      expect(await names('?status=unresolved')).toEqual(['Vivek Sharma 07']);
      expect(await names('?status=leave')).toEqual(['Nisha Varma 08']);
      expect(await names('?flag=late')).toEqual(['Fatima Khan 08', 'Fatima Khan 07']);
      expect(await names('?flag=early_departure')).toEqual(['Joseph Mathew 07']);
      expect(await names('?flag=pending_correction')).toEqual(['Vivek Sharma 07']);
      expect(await names('?flag=late&status=present')).toEqual(['Fatima Khan 07']);
      expect(await names(`?employeeId=${await idByKey('employee')}`)).toEqual(['Arjun Das 08', 'Arjun Das 07']);
      expect(await names(`?managerId=${await idByKey('lead')}&from=${MON}&to=${MON}`)).toEqual(['Divya Thomas 07', 'Imran Sheikh 07']);
      const support = (await mod.db().departments.findOne({ name: 'Support' }))!._id;
      expect(await names(`?departmentId=${support}`)).toEqual(['Nisha Varma 08', 'Nisha Varma 07']);
      expect(await names(`?from=${TUE}`)).toHaveLength(10);

      const hr = await person('hr');
      expect((await hr.get<ErrorPayload>(`/attendance/records?from=${TUE}&to=${MON}`)).body.fields).toEqual({ to: 'The last day cannot be before the first.' });
      expect((await hr.get<ErrorPayload>('/attendance/records?from=2026-06-01&to=2026-12-08')).body.fields).toEqual({ to: 'Choose 92 days or fewer at a time.' });
      expect((await hr.get('/attendance/records?status=sleeping')).status).toBe(400);
      expect((await hr.get('/attendance/records?employeeId=emp_000000000000')).status).toBe(404);
      expect((await hr.get<RecordsPayload>('/attendance/records?page=2')).body.items).toEqual([]);
    });

    it('says how often each person was late in the stretch', async () => {
      const late = (await recordsAs('hr')).body.late;
      expect(late.map((row) => [row.name, row.code, row.entries, row.excused, row.minutes])).toEqual([['Fatima Khan', 'EMP-0003', 2, 0, 130]]);
      // It is about the people and the dates in view, whatever else the list is narrowed to.
      expect((await recordsAs('hr', '?status=absent')).body.late).toHaveLength(1);
      expect((await recordsAs('hr', `?from=${TUE}`)).body.late[0]).toMatchObject({ entries: 1, minutes: 100 });
      expect((await recordsAs('hr', `?managerId=${await idByKey('lead')}`)).body.late).toEqual([]);
    });

    it('shows a Manager their team’s days and nobody else’s', async () => {
      const mine = (await recordsAs('manager')).body;
      // Arjun, Divya, Imran and Vivek have days; Meera has none yet. Fatima's own days are not her team's.
      expect([...new Set(mine.items.map((row) => row.name))].sort()).toEqual(['Arjun Das', 'Divya Thomas', 'Imran Sheikh', 'Vivek Sharma']);
      expect(mine.total).toBe(8);
      expect(mine.late).toEqual([]);
      expect((await recordsAs('manager', `?employeeId=${await idByKey('joseph')}`)).status).toBe(404);
      expect((await recordsAs('manager', `?employeeId=${await idByKey('manager')}`)).status).toBe(404);
      expect((await recordsAs('manager', `?managerId=${await idByKey('nisha')}`)).status).toBe(404);
    });
  });

  describe('reports', () => {
    it('the monthly report equals the calendar’s summary for each person', async () => {
      const report = (await monthlyAs('hr', '?month=2026-12')).body;
      expect(report).toMatchObject({ month: '2026-12', from: '2026-12-01', to: '2026-12-31', today: TUE });
      // Eleven people have days that count in December (Meera's start on the 14th). Kiran has no schedule, and Leela left in October.
      expect(report.rows.map((row) => row.name)).toEqual(['Anita Menon', 'Arjun Das', 'Divya Thomas', 'Fatima Khan', 'Imran Sheikh', 'Joseph Mathew', 'Meera Pillai', 'Nisha Varma', 'Rahul Nair', 'Sneha Iyer', 'Vivek Sharma']);
      expect(report.notCounted).toBe(2);
      for (const key of ['admin', 'employee', 'divya', 'manager', 'imran', 'joseph', 'newjoiner', 'nisha', 'hr', 'sneha', 'lead']) {
        expect(report.rows.find((row) => row.name === nameByKey(key))!.summary, key).toEqual((await monthOf(key)).summary);
      }
      expect(report.rows.find((row) => row.name === 'Fatima Khan')!.summary).toMatchObject({ workingDays: 1, presentDays: 1, lateEntries: 2, workedMinutes: 480 });
      // Nisha's leave is today, and today is not over: it is counted once it is.
      expect(report.rows.find((row) => row.name === 'Nisha Varma')!.summary).toMatchObject({ workingDays: 1, absentDays: 1, leaveDays: 0 });
      // The totals are the rows added up.
      expect(report.totals.workedMinutes).toBe(report.rows.reduce((sum, row) => sum + row.summary.workedMinutes, 0));
      expect(report.totals).toMatchObject({ presentDays: 3, halfDays: 1, unresolvedDays: 1, lateEntries: 2, absentDays: 5.5 });
      // With no month named it is this month.
      expect((await monthlyAs('hr')).body.month).toBe('2026-12');
      expect((await monthlyAs('hr', '?month=2026-13')).status).toBe(400);
      // A month before anyone had a schedule has no rows.
      expect((await monthlyAs('hr', '?month=2026-11')).body).toMatchObject({ rows: [], notCounted: 13 });
    });

    it('a Manager’s report is their team’s; the people they may choose from are their team', async () => {
      const mine = (await monthlyAs('manager')).body;
      expect(mine.rows.map((row) => row.name)).toEqual(['Arjun Das', 'Divya Thomas', 'Imran Sheikh', 'Meera Pillai', 'Vivek Sharma']);
      expect((await monthlyAs('manager', `?managerId=${await idByKey('lead')}`)).body.rows.map((row) => row.name)).toEqual(['Divya Thomas', 'Imran Sheikh']);
      expect((await monthlyAs('manager', `?managerId=${await idByKey('nisha')}`)).status).toBe(404);

      const people = async (key: string) => (await (await person(key)).get<ReportPerson[]>('/reports/people')).body;
      expect((await people('manager')).map((p) => [p.name, p.hasReports])).toEqual([
        ['Arjun Das', false],
        ['Divya Thomas', false],
        ['Imran Sheikh', false],
        ['Meera Pillai', false],
        ['Vivek Sharma', true],
      ]);
      // HR chooses from everyone, also someone who has left: their past months are still theirs.
      const everyone = await people('hr');
      expect(everyone).toHaveLength(13);
      expect(everyone.find((p) => p.name === 'Leela George')).toMatchObject({ status: 'inactive', departmentName: 'Support' });
      expect(everyone.filter((p) => p.hasReports).map((p) => p.name)).toEqual(['Anita Menon', 'Fatima Khan', 'Nisha Varma', 'Vivek Sharma']);
    });

    it('gives one person’s days to them, to their managers and to HR, and to nobody else', async () => {
      const own = (await employeeAs('employee', 'employee', `?from=${MON}&to=${TUE}`)).body;
      expect(own).toMatchObject({ employee: { name: 'Arjun Das', code: 'EMP-0004', departmentName: 'Sales' }, from: MON, to: TUE, timeZone: ZONE });
      expect(own.days.map((day) => [day.date, day.status])).toEqual([
        [MON, 'present'],
        [TUE, 'working'],
      ]);
      expect(own.summary).toMatchObject({ workingDays: 1, presentDays: 1, workedMinutes: 480 });
      // Over the whole month it is the calendar's own summary.
      expect((await employeeAs('employee', 'employee', '?from=2026-12-01&to=2026-12-31')).body.summary).toEqual((await monthOf('employee')).summary);
      // With no dates: this month so far.
      expect((await employeeAs('employee', 'employee')).body).toMatchObject({ from: '2026-12-01', to: TUE });

      expect((await employeeAs('employee', 'divya')).status).toBe(404);
      expect((await employeeAs('employee', 'manager')).status).toBe(404);
      expect((await employeeAs('manager', 'employee')).body.employee.name).toBe('Arjun Das');
      expect((await employeeAs('manager', 'joseph')).status).toBe(404);
      expect((await employeeAs('lead', 'employee')).status).toBe(404);
      expect((await employeeAs('hr', 'joseph', `?from=${MON}&to=${MON}`)).body.days[0]).toMatchObject({ status: 'half_day' });
      expect((await employeeAs('hr', 'joseph', '?from=2025-01-01&to=2026-12-08')).body.fields).toEqual({ to: 'Choose 366 days or fewer at a time.' });
      expect((await (await person('hr')).get('/reports/employee/emp_000000000000')).status).toBe(404);
    });
  });

  describe('CSV content and escaping', () => {
    it('sends the monthly summary as a file a spreadsheet opens, with the report’s own numbers', async () => {
      const hr = await person('hr');
      const file = await hr.text('/reports/monthly?month=2026-12&format=csv');
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(file.headers.get('content-disposition')).toBe('attachment; filename="monthly-summary-2026-12.csv"');
      expect(file.headers.get('x-content-type-options')).toBe('nosniff');
      expect(file.text.startsWith('﻿Employee code,Name,Department,Working days counted,Present,')).toBe(true);
      expect(file.text.endsWith('\r\n')).toBe(true);

      const rows = parseCsv(file.text);
      const report = (await monthlyAs('hr', '?month=2026-12')).body;
      expect(rows).toHaveLength(report.rows.length + 2);
      const fatima = report.rows.find((row) => row.name === 'Fatima Khan')!.summary;
      // One full day counted so far, two late entries, eight hours; and the month's three Sundays still to come.
      expect(rows.find((row) => row[1] === 'Fatima Khan')).toEqual(['EMP-0003', 'Fatima Khan', 'Sales', '1', '1', '0', '0', '0', '0', '0', '2', '0', '0', '0', '3', '0', '8']);
      expect(fatima).toMatchObject({ workingDays: 1, presentDays: 1, lateEntries: 2, weeklyOffs: 3, workedMinutes: 480 });
      expect(rows.at(-1)!.slice(0, 5)).toEqual(['', 'Total', '', String(report.totals.workingDays), '3']);
      expect((await auditOf('report.exported')).at(-1)).toMatchObject({ actor: { name: 'Rahul Nair' }, summary: 'Downloaded the monthly summary for December 2026: 11 people.' });
    });

    it('makes text that starts like a formula safe, and keeps commas and quotes inside their cell', async () => {
      // Someone's name and a department's name, typed to do harm in a spreadsheet.
      await mod.db().employees.updateOne({ _id: await idByKey('imran') }, { $set: { name: '=HYPERLINK("http://evil.example","Imran")' } });
      await mod.db().departments.updateOne({ name: 'Sales' }, { $set: { name: '+Sales, "East"' } });
      const file = await (await person('hr')).text('/reports/monthly?month=2026-12&format=csv');
      // As written in the file: an apostrophe first, and the quotes doubled.
      expect(file.text).toContain('EMP-0008,"\'=HYPERLINK(""http://evil.example"",""Imran"")","\'+Sales, ""East""",');
      // As a spreadsheet reads it back: one cell each, and text, not a formula.
      const row = parseCsv(file.text).find((cells) => cells[0] === 'EMP-0008')!;
      expect(row.slice(0, 3)).toEqual(['EMP-0008', '\'=HYPERLINK("http://evil.example","Imran")', '\'+Sales, "East"']);
      expect(row).toHaveLength(17);
      await mod.db().employees.updateOne({ _id: await idByKey('imran') }, { $set: { name: 'Imran Sheikh' } });
      await mod.db().departments.updateOne({ name: '+Sales, "East"' }, { $set: { name: 'Sales' } });
    });

    it('sends the records as a file: every row that matches, not one page of them', async () => {
      const file = await (await person('hr')).text(`/attendance/records?from=${MON}&to=${TUE}&format=csv`);
      expect(file.headers.get('content-disposition')).toBe(`attachment; filename="attendance-records-${MON}-to-${TUE}.csv"`);
      const rows = parseCsv(file.text);
      expect(rows[0]).toEqual(['Employee code', 'Name', 'Department', 'Date', 'Day', 'Status', 'Notes', 'Check-in', 'Check-out', 'Break (minutes)', 'Worked (hours)', 'Late by (minutes)', 'Left early by (minutes)', 'Holiday', 'Leave']);
      expect(rows).toHaveLength(21);
      expect(rows.find((row) => row[1] === 'Fatima Khan' && row[3] === MON)).toEqual(['EMP-0003', 'Fatima Khan', 'Sales', MON, 'Monday', 'Present', 'Late by 30 min', '09:30', '18:30', '60', '8', '30', '', '', '']);
      expect(rows.find((row) => row[1] === 'Nisha Varma' && row[3] === TUE)!.slice(5)).toEqual(['Leave', '', '', '', '', '', '', '', '', 'Unpaid leave']);
      expect(rows.find((row) => row[1] === 'Vivek Sharma' && row[3] === MON)!.slice(5, 9)).toEqual(['Unresolved', 'Correction pending', '10:00', '']);
      const late = parseCsv((await (await person('hr')).text('/attendance/records?flag=late&format=csv')).text);
      expect(late.slice(1).map((row) => `${row[1]} ${row[3]}`)).toEqual([`Fatima Khan ${TUE}`, `Fatima Khan ${MON}`]);
    });

    it('lets a Manager download their team’s, an Employee only their own, and writes down who took what', async () => {
      const before = (await auditOf('report.exported')).length;
      const team = parseCsv((await (await person('manager')).text('/reports/monthly?format=csv')).text);
      expect(team.slice(1, -1).map((row) => row[1])).toEqual(['Arjun Das', 'Divya Thomas', 'Imran Sheikh', 'Meera Pillai', 'Vivek Sharma']);
      expect((await (await person('manager')).text(`/attendance/records?employeeId=${await idByKey('joseph')}&format=csv`)).status).toBe(404);
      const arjunByFatima = await (await person('manager')).text(`/reports/employee/${await idByKey('employee')}?from=${MON}&to=${TUE}&format=csv`);
      expect(arjunByFatima.headers.get('content-disposition')).toBe(`attachment; filename="attendance-EMP-0004-${MON}-to-${TUE}.csv"`);
      expect(parseCsv(arjunByFatima.text).map((row) => row.slice(0, 6))).toEqual([
        ['Date', 'Day', 'Status', 'Notes', 'Check-in', 'Check-out'],
        [MON, 'Monday', 'Present', '', '09:00', '18:00'],
        [TUE, 'Tuesday', 'Working', '', '09:05', ''],
      ]);
      const audit = await auditOf('report.exported');
      expect(audit.slice(before).map((row) => [row.actor?.name, row.summary])).toEqual([
        ['Fatima Khan', 'Downloaded the monthly summary for December 2026: 5 people.'],
        ['Fatima Khan', `Downloaded Arjun Das's attendance from ${MON} to ${TUE}.`],
      ]);

      // Arjun takes his own days away with him: no permission needed, and nothing to write down.
      const employee = await person('employee');
      const own = await employee.text(`/reports/employee/${await idByKey('employee')}?from=${MON}&to=${TUE}&format=csv`);
      expect([own.status, parseCsv(own.text)]).toEqual([200, parseCsv(arjunByFatima.text)]);
      expect((await auditOf('report.exported')).length).toBe(before + 2);
      // Nobody else's, by any route.
      expect((await employee.text(`/reports/employee/${await idByKey('divya')}?format=csv`)).status).toBe(404);
      expect((await employee.text('/reports/monthly?format=csv')).status).toBe(403);
      expect((await employee.text('/attendance/records?format=csv')).status).toBe(403);
      expect((await employee.text('/reports/monthly?format=xlsx')).status).toBe(403);
      expect((await (await person('hr')).text('/reports/monthly?format=xlsx')).status).toBe(400);
    });
  });

  describe('a shift that began yesterday', () => {
    it('shows someone still at work after midnight on the shift they are in', async () => {
      // Imran goes on nights from Wednesday: 22:00 to 06:00.
      setNow(TUE, '12:00');
      const night = { ...exampleA(ZONE), name: 'Nights', standard: { start: '22:00', end: '06:00', requiredMinutes: 420, fullDayMinutes: 400, halfDayMinutes: 200 } };
      const given = await (await person('hr')).post<AssignmentResult>('/schedule-assignments', { employeeIds: [await idByKey('imran')], scheduleId: null, rules: night, effectiveFrom: WED, note: '' });
      expect(given.body.assigned).toHaveLength(1);
      setNow(WED, '22:00');
      await punch('imran', 'check-in');

      // Thursday, one in the morning. His Thursday shift has not begun; he is at work on Wednesday's.
      setNow(THU, '01:00');
      const now = (await overviewAs('hr', '?filter=working')).body;
      expect(now.date).toBe(THU);
      expect(now.people.items.map((row) => [row.name, row.day.date, row.day.status, row.scheduleName])).toEqual([['Imran Sheikh', WED, 'working', 'Nights']]);
      expect(now.counts).toMatchObject({ working: 1, checked_in: 1 });
      // Looked at as Wednesday, it is the same shift; looked at as a day that is not today, nothing is carried over.
      expect((await overviewAs('hr', `?date=${WED}&filter=working`)).body.people.items.map((row) => row.name)).toEqual(['Imran Sheikh']);
      const schedule = (await (await person('hr')).get<{ current: ScheduleAssignment }>(`/employees/${await idByKey('imran')}/schedule`)).body;
      expect(schedule.current.rules.name).toBe('Nights');
    });
  });

  describe('a company of five hundred', () => {
    it('a month for 500 people answers quickly', async () => {
      // Five hundred more people, each on the 9-to-6 schedule since 1 December, with five days of punches.
      const rules = exampleA(ZONE);
      const now = moment(THU, '01:00');
      const sales = (await mod.db().departments.findOne({ name: 'Sales' }))!._id;
      const admin = await idByKey('admin');
      const ids = Array.from({ length: 500 }, (_, i) => `emp_bulk${String(i).padStart(4, '0')}`);
      await mod.db().employees.insertMany(
        ids.map((id, i) => ({
          _id: id,
          code: `EMP-9${String(i).padStart(3, '0')}`,
          name: `Person ${String(i).padStart(3, '0')}`,
          email: `person${i}@bulk.test`,
          phone: '',
          role: 'Employee' as const,
          departmentId: sales,
          designation: 'Executive',
          managerId: admin,
          joinDate: null,
          employment: [{ from: '2026-12-01', to: null }],
          status: 'active' as const,
          leavePolicyId: null,
          mustChangePassword: false,
          createdAt: now,
          updatedAt: now,
          passwordHash: 'x',
        })),
      );
      await mod.db().scheduleAssignments.insertMany(ids.map((id, i) => ({ _id: `asg_bulk${String(i).padStart(4, '0')}`, employeeId: id, effectiveFrom: '2026-12-01', scheduleId: null, rules, holidayCalendarId: null, note: '', createdBy: admin, createdByName: 'Anita Menon', createdAt: now })));
      const dates = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05'];
      await mod.db().attendanceDays.insertMany(
        ids.flatMap((id, i) =>
          dates.map((date, d) => ({
            _id: `${id}|${date}`,
            employeeId: id,
            date,
            assignmentId: `asg_bulk${String(i).padStart(4, '0')}`,
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

      const timed = async <T>(run: () => Promise<T>) => {
        const started = performance.now();
        const answer = await run();
        return { answer, ms: performance.now() - started };
      };
      const hr = await person('hr');

      const month = await timed(() => hr.get<MonthlyReportPayload>('/reports/monthly?month=2026-12'));
      expect(month.answer.body.rows).toHaveLength(511);
      // 500 people for 31 days is 15,500 days read by the engine. A few seconds would already be slow.
      expect(month.ms, `the month took ${Math.round(month.ms)} ms`).toBeLessThan(5000);
      const one = month.answer.body.rows.find((row) => row.code === 'EMP-9000')!;
      expect(one.summary).toEqual((await (await person('admin')).get<AttendanceCalendarPayload>('/attendance/calendar?employeeId=emp_bulk0000&month=2026-12')).body.summary);

      const day = await timed(() => hr.get<OverviewPayload>('/dashboard/hr?date=2026-12-03'));
      expect(day.answer.body.counts.all).toBe(512);
      expect(day.answer.body.people.items).toHaveLength(50);
      expect(day.ms, `the day took ${Math.round(day.ms)} ms`).toBeLessThan(3000);

      const week = await timed(() => hr.get<RecordsPayload>('/attendance/records?from=2026-12-01&to=2026-12-07&flag=late'));
      expect(week.answer.body.total).toBeGreaterThan(300);
      expect(week.answer.body.items).toHaveLength(50);
      expect(week.ms, `the records took ${Math.round(week.ms)} ms`).toBeLessThan(3000);

      const file = await timed(() => hr.text('/reports/monthly?month=2026-12&format=csv'));
      expect(parseCsv(file.answer.text)).toHaveLength(513);
      expect(file.ms, `the file took ${Math.round(file.ms)} ms`).toBeLessThan(5000);
      console.info(`[reports] 500 people: month ${Math.round(month.ms)} ms, day ${Math.round(day.ms)} ms, records ${Math.round(week.ms)} ms, CSV ${Math.round(file.ms)} ms`);
    });
  });
});
