/*
 * End-to-end tests of holiday calendars, holidays and the month calendar (Phase 5) against a
 * real MongoDB. The clock is set by the tests and only ever moves forward through the file.
 *
 * What a holiday does to a day is the engine's and is tested in shared. Here it is the API:
 * who may manage calendars, that a person's holidays come from the calendar they were on at
 * each date, that changing a day that has already begun is shown, confirmed and audited, and
 * who may open whose month.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  CONFIRM_PAST,
  describeToday,
  OWN_RECORD_MESSAGE,
  summarize,
  zonedToInstant,
  type AssignmentResult,
  type AttendanceCalendarPayload,
  type CalendarDetailPayload,
  type CalendarListPayload,
  type CopyYearResult,
  type DayDetailPayload,
  type EmployeeSchedulePayload,
  type ErrorPayload,
  type Holiday,
  type HolidayCalendar,
  type HolidayEffect,
  type MyDashboardPayload,
  type MyHolidaysPayload,
  type PersonOption,
  type TemporaryPasswordPayload,
  type TodayPayload,
} from '@delta-hrms/shared';
import { as, boot, Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

const ZONE = 'Asia/Kolkata';
/** Monday 7 December 2026: the day the sample company is created. */
const MON = '2026-12-07';
const day = (n: number) => addDays(MON, n);
const [TUE, WED, THU, FRI, SUN, NEXT_MON] = [day(1), day(2), day(3), day(4), day(6), day(7)];
const CHRISTMAS = '2026-12-25';

const moment = (date: string, time: string) => zonedToInstant(date, time, ZONE).toISOString();
const setNow = (date: string, time: string) => mod.clock.setTestNow(moment(date, time));

beforeAll(async () => {
  await boot('holidays');
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

/** The ids of the calendars and holidays the tests make, by name. */
const made = new Map<string, string>();
const idOfMade = (name: string) => made.get(name)!;

async function addHoliday(calendar: string, date: string, name: string, type: Holiday['type'] = 'public', more: Record<string, unknown> = {}) {
  const hr = await as('HR');
  const answer = await hr.post<Holiday & ErrorPayload>('/holidays', { calendarId: idOfMade(calendar), date, name, type, description: '', ...more });
  if (answer.status === 201) made.set(name, answer.body.id);
  return answer;
}
const give = async (client: Client, calendar: string | null, keys: string[], effectiveFrom: string) =>
  client.post<AssignmentResult>('/holiday-calendars/assign', { calendarId: calendar ? idOfMade(calendar) : null, employeeIds: await Promise.all(keys.map(idByKey)), effectiveFrom });
const dayOf = async (key: string, date: string) => (await (await as('HR')).get<DayDetailPayload>(`/attendance/days/${await idByKey(key)}/${date}`)).body.day;
const punch = async (key: string, action: 'check-in' | 'check-out') => {
  const answer = await (await person(key)).post<TodayPayload & ErrorPayload>(`/attendance/${action}`);
  expect(answer.status, `${key} ${action}: ${answer.body?.error ?? ''}`).toBe(200);
  return answer.body;
};
/** The audit rows of one kind, in the order they were written. (The test clock stands still, so their times can tie.) */
const auditOf = (action: string) => mod.db().audit.find({ action }).sort({ $natural: 1 }).toArray();

describe.skipIf(!reachable)('holidays', () => {
  describe('calendars', () => {
    it('are for people who manage holidays', async () => {
      for (const role of ['Employee', 'Manager'] as const) {
        const client = await as(role);
        expect((await client.get('/holiday-calendars')).status).toBe(403);
        expect((await client.post('/holiday-calendars', { name: 'Mine' })).status).toBe(403);
        expect((await client.post('/holiday-calendars/assign', { calendarId: null, employeeIds: [await idByKey('employee')], effectiveFrom: TUE })).status).toBe(403);
        expect((await client.post('/holidays', { calendarId: 'cal_000000000000', date: CHRISTMAS, name: 'Christmas', type: 'public', description: '' })).status).toBe(403);
      }
    });

    it('have a name of their own, and the first one becomes the company default', async () => {
      setNow(MON, '08:00');
      const hr = await as('HR');
      const start = (await hr.get<CalendarListPayload>('/holiday-calendars')).body;
      // Ten people have a schedule in force today (not the new joiner, Kiran or Leela), and none has a calendar.
      expect(start).toEqual({ year: 2026, calendars: [], withoutCalendar: 10 });

      const india = await hr.post<HolidayCalendar>('/holiday-calendars', { name: '  India ' });
      expect(india.status).toBe(201);
      expect(india.body.name).toBe('India');
      made.set('India', india.body.id);
      const uae = await hr.post<HolidayCalendar>('/holiday-calendars', { name: 'UAE' });
      made.set('UAE', uae.body.id);

      for (const name of ['india', ' INDIA  ']) {
        const taken = await hr.post<ErrorPayload>('/holiday-calendars', { name });
        expect(taken.status).toBe(422);
        expect(taken.body.fields).toEqual({ name: 'Another calendar already has that name.' });
      }
      expect((await hr.post<ErrorPayload>('/holiday-calendars', { name: ' ' })).body.fields).toEqual({ name: 'Give the calendar a name.' });
      expect((await hr.post('/holiday-calendars', { name: 'X', isDefault: true })).status).toBe(400);

      const list = (await hr.get<CalendarListPayload>('/holiday-calendars')).body.calendars;
      expect(list.map((c) => [c.name, c.isDefault, c.holidayCount, c.peopleCount])).toEqual([
        ['India', true, 0, 0],
        ['UAE', false, 0, 0],
      ]);
      expect((await auditOf('holiday_calendar.created')).map((a) => a.summary)).toEqual(['Created the holiday calendar "India", which became the company default.', 'Created the holiday calendar "UAE".']);
    });

    it('can be renamed, and the default changed, without changing anyone', async () => {
      const hr = await as('HR');
      expect((await hr.patch<HolidayCalendar>(`/holiday-calendars/${idOfMade('UAE')}`, { name: 'India' })).status).toBe(422);
      expect((await hr.patch<HolidayCalendar>(`/holiday-calendars/${idOfMade('UAE')}`, { name: 'UAE office' })).body.name).toBe('UAE office');
      const assignmentsBefore = await mod.db().scheduleAssignments.find().sort({ _id: 1 }).toArray();
      expect((await hr.post(`/holiday-calendars/${idOfMade('UAE')}/default`)).status).toBe(204);
      expect((await hr.get<CalendarListPayload>('/holiday-calendars')).body.calendars.map((c) => [c.name, c.isDefault])).toEqual([
        ['India', false],
        ['UAE office', true],
      ]);
      expect(await mod.db().scheduleAssignments.find().sort({ _id: 1 }).toArray()).toEqual(assignmentsBefore);
      expect((await hr.post(`/holiday-calendars/${idOfMade('India')}/default`)).status).toBe(204);
      expect((await hr.post('/holiday-calendars/cal_000000000000/default')).status).toBe(404);
    });
  });

  describe('a holiday', () => {
    it('is added to a calendar, one to a date, and checked field by field', async () => {
      const hr = await as('HR');
      expect((await addHoliday('India', WED, 'Founders Day', 'company')).status).toBe(201);
      expect((await addHoliday('India', FRI, 'Regional festival', 'optional')).status).toBe(201);
      expect((await addHoliday('India', SUN, 'Stock-taking', 'special_working_day')).status).toBe(201);
      const christmas = await addHoliday('India', CHRISTMAS, '  Christmas Day ', 'public', { description: ' Office closed ' });
      expect(christmas.body).toMatchObject({ date: CHRISTMAS, name: 'Christmas Day', type: 'public', description: 'Office closed', createdByName: 'Rahul Nair' });
      expect((await addHoliday('UAE', TUE, 'National Day')).status).toBe(201);

      const again = await addHoliday('India', CHRISTMAS, 'Another');
      expect(again.status).toBe(422);
      expect(again.body.fields).toEqual({ date: 'That date already has a holiday on this calendar.' });
      // The same date on another calendar is another holiday.
      expect((await addHoliday('UAE', CHRISTMAS, 'Christmas (UAE)', 'optional')).status).toBe(201);

      expect((await addHoliday('India', '2026-02-30', 'Nonsense')).body.fields).toEqual({ date: 'Choose the date of the holiday.' });
      expect((await addHoliday('India', '2027-01-01', ' ')).body.fields).toEqual({ name: 'Give the holiday a name.' });
      expect((await hr.post('/holidays', { calendarId: idOfMade('India'), date: '2027-01-01', name: 'New Year', type: 'bank', description: '' })).status).toBe(400);
      expect((await hr.post('/holidays', { calendarId: idOfMade('India'), date: '2027-01-01', name: 'New Year', type: 'public', description: '', paid: true })).status).toBe(400);
      expect((await hr.post('/holidays', { calendarId: 'cal_000000000000', date: '2027-01-01', name: 'New Year', type: 'public', description: '' })).status).toBe(404);

      const detail = (await hr.get<CalendarDetailPayload>(`/holiday-calendars/${idOfMade('India')}?year=2026`)).body;
      expect(detail).toMatchObject({ name: 'India', isDefault: true, year: 2026, today: MON, holidayCount: 4, years: [2026], people: [] });
      expect(detail.holidays.map((h) => [h.date, h.name, h.type])).toEqual([
        [WED, 'Founders Day', 'company'],
        [FRI, 'Regional festival', 'optional'],
        [SUN, 'Stock-taking', 'special_working_day'],
        [CHRISTMAS, 'Christmas Day', 'public'],
      ]);
      expect((await hr.get<CalendarDetailPayload>(`/holiday-calendars/${idOfMade('India')}?year=2027`)).body.holidays).toEqual([]);
      expect((await hr.get(`/holiday-calendars/${idOfMade('India')}?year=1999`)).status).toBe(400);
    });
  });

  describe('putting people on a calendar', () => {
    it('starts tomorrow at the earliest, and says who was moved and who was not, and why', async () => {
      setNow(MON, '09:00');
      const hr = await as('HR');
      const tooSoon = await give(hr, 'India', ['employee'], MON);
      expect(tooSoon.body).toEqual({ assigned: [], skipped: [{ employeeId: await idByKey('employee'), name: 'Arjun Das', reason: 'A change of holiday calendar can start tomorrow at the earliest, so no day that has begun changes.' }] });

      const answer = await give(hr, 'India', ['employee', 'manager', 'joseph', 'hr', 'kiran', 'leela', 'newjoiner'], TUE);
      expect(answer.status).toBe(200);
      expect(answer.body.assigned.map((p) => p.name).sort()).toEqual(['Arjun Das', 'Fatima Khan', 'Joseph Mathew', 'Meera Pillai']);
      const reasons = Object.fromEntries(answer.body.skipped.map((p) => [p.name, p.reason]));
      expect(reasons).toEqual({
        'Rahul Nair': OWN_RECORD_MESSAGE,
        'Kiran Babu': 'They have no work schedule yet. The holiday calendar is given with the schedule: give them one first.',
        'Leela George': 'They are deactivated. Reactivate them first.',
      });
      expect((await give(hr, 'UAE', ['divya'], TUE)).body.assigned).toHaveLength(1);

      // A second time changes nothing, and says so.
      const again = await give(hr, 'India', ['employee'], TUE);
      expect(again.body).toEqual({ assigned: [], skipped: [{ employeeId: await idByKey('employee'), name: 'Arjun Das', reason: 'They are already on the holiday calendar "India" from that date.' }] });
      expect((await give(hr, 'India', ['employee'], '2026-02-30')).status).toBe(400);
      expect((await hr.post('/holiday-calendars/assign', { calendarId: 'cal_000000000000', employeeIds: [await idByKey('employee')], effectiveFrom: TUE })).status).toBe(404);
    });

    it('adds a new assignment from that date with the same rules, and leaves every earlier day as it was', async () => {
      const arjun = await mod.db().scheduleAssignments.find({ employeeId: await idByKey('employee') }).sort({ effectiveFrom: 1 }).toArray();
      expect(arjun.map((a) => [a.effectiveFrom, a.holidayCalendarId, a.rules.name, a.note])).toEqual([
        [MON, null, 'General 9 to 6', ''],
        [TUE, idOfMade('India'), 'General 9 to 6', 'Holiday calendar: India'],
      ]);
      expect(arjun[1]!.rules).toEqual(arjun[0]!.rules);
      expect(arjun[1]!.scheduleId).toBe(arjun[0]!.scheduleId);
      expect(arjun[1]!.createdByName).toBe('Rahul Nair');

      // Someone whose schedule has not started yet has no day to protect: the planned assignment itself is changed.
      const meera = await mod.db().scheduleAssignments.find({ employeeId: await idByKey('newjoiner') }).toArray();
      expect(meera.map((a) => [a.effectiveFrom, a.holidayCalendarId])).toEqual([[NEXT_MON, idOfMade('India')]]);

      const audits = await auditOf('holiday_calendar.assigned');
      expect(audits).toHaveLength(5);
      expect(audits.find((a) => a.employeeId === arjun[0]!.employeeId)).toMatchObject({ summary: `Put Arjun Das on the holiday calendar "India" from ${TUE}.`, before: { holidayCalendarId: null }, after: { holidayCalendarId: idOfMade('India'), effectiveFrom: TUE } });
    });

    it('shows on the person’s schedule, in the list of calendars, and in the people picker', async () => {
      const hr = await as('HR');
      const schedule = (await hr.get<EmployeeSchedulePayload>(`/employees/${await idByKey('employee')}/schedule`)).body;
      expect(schedule.calendarNames).toEqual({ [idOfMade('India')]: 'India' });
      expect(schedule.planned.map((a) => a.holidayCalendarId)).toEqual([idOfMade('India')]);
      expect(schedule.current?.holidayCalendarId).toBeNull();

      setNow(TUE, '08:00');
      const list = (await hr.get<CalendarListPayload>('/holiday-calendars')).body;
      expect(list.calendars.map((c) => [c.name, c.peopleCount])).toEqual([
        ['India', 3],
        ['UAE office', 1],
      ]);
      expect(list.withoutCalendar).toBe(6);
      const detail = (await hr.get<CalendarDetailPayload>(`/holiday-calendars/${idOfMade('India')}`)).body;
      expect(detail.people.map((p) => [p.name, p.effectiveFrom])).toEqual([
        ['Arjun Das', TUE],
        ['Fatima Khan', TUE],
        ['Joseph Mathew', TUE],
      ]);
      const picker = (await hr.get<PersonOption[]>('/employees/picker')).body;
      expect(Object.fromEntries(picker.filter((p) => ['Arjun Das', 'Divya Thomas', 'Vivek Sharma'].includes(p.name)).map((p) => [p.name, p.calendarName]))).toEqual({ 'Arjun Das': 'India', 'Divya Thomas': 'UAE office', 'Vivek Sharma': null });
    });

    it('is not something anyone does to their own record, unless nobody else can', async () => {
      const admin = await as('Admin');
      // Another Admin or HR may: the Admin puts HR on the calendar.
      expect((await give(admin, 'India', ['hr'], WED)).body.assigned.map((p) => p.name)).toEqual(['Rahul Nair']);
      expect((await give(admin, 'India', ['admin'], WED)).body.skipped[0]?.reason).toBe(OWN_RECORD_MESSAGE);
    });
  });

  describe('what a holiday does to a day', () => {
    it('is read from the calendar the person was on that day: two calendars, two different days', async () => {
      // Tuesday: Arjun works a full day. It is National Day on the UAE calendar, which only Divya is on.
      setNow(TUE, '09:00');
      await punch('employee', 'check-in');
      setNow(TUE, '18:00');
      await punch('employee', 'check-out');

      setNow(THU, '10:00');
      expect(await dayOf('divya', TUE)).toMatchObject({ kind: 'holiday', status: 'holiday', units: null, holiday: { name: 'National Day', type: 'public' } });
      expect(await dayOf('employee', TUE)).toMatchObject({ kind: 'working', status: 'present', holiday: null });
      expect(await dayOf('imran', TUE)).toMatchObject({ kind: 'working', status: 'absent' });

      // Wednesday is Founders Day on India. Nobody came: for those on India that is a holiday, never an absence.
      expect(await dayOf('employee', WED)).toMatchObject({ kind: 'holiday', status: 'holiday', units: null, holiday: { name: 'Founders Day', type: 'company' } });
      expect(await dayOf('manager', WED)).toMatchObject({ status: 'holiday' });
      expect(await dayOf('divya', WED)).toMatchObject({ kind: 'working', status: 'absent', units: { absent: 1 } });
      expect(await dayOf('lead', WED)).toMatchObject({ kind: 'working', status: 'absent' });
    });

    it('does not reach back before the person was on the calendar', async () => {
      // Monday is given a holiday on India. On Monday nobody was on India yet: nobody's Monday changes, and nothing needs confirming.
      const before = await dayOf('employee', MON);
      const added = await addHoliday('India', MON, 'Declared after the fact');
      expect(added.status).toBe(201);
      expect(await dayOf('employee', MON)).toEqual(before);
      expect(before).toMatchObject({ kind: 'working', status: 'absent', holiday: null });
    });

    it('an optional holiday is shown and stays a working day; a special working day makes a weekly off a working day on the normal hours', async () => {
      setNow(NEXT_MON, '10:00');
      // Friday: an optional holiday. Arjun did not come and took no leave.
      expect(await dayOf('employee', FRI)).toMatchObject({ kind: 'working', status: 'absent', units: { absent: 1 }, holiday: { name: 'Regional festival', type: 'optional' } });
      // Sunday is Fatima's weekly off, worked this once: a working day, on the normal 9 to 6.
      expect(await dayOf('manager', SUN)).toMatchObject({ kind: 'working', status: 'absent', requiredMinutes: 480, shiftStartAt: moment(SUN, '09:00'), shiftEndAt: moment(SUN, '18:00'), holiday: { type: 'special_working_day' } });
      // For Imran, who is on no calendar, it is the working Sunday it always was; for Divya, on the other calendar, too.
      expect(await dayOf('imran', SUN)).toMatchObject({ kind: 'working', holiday: null });
      // Vivek's week has Friday off, and no calendar says otherwise.
      expect(await dayOf('lead', FRI)).toMatchObject({ kind: 'weekly_off', status: 'weekly_off' });
    });

    it('reaches the home page: today as a holiday, with a check-in that is recorded as work on a day off', async () => {
      setNow(CHRISTMAS, '10:00');
      const arjun = await person('employee');
      const home = (await arjun.get<MyDashboardPayload>('/dashboard/me')).body;
      expect(home.today.day).toMatchObject({ kind: 'holiday', status: 'holiday', holiday: { name: 'Christmas Day' } });
      expect(home.today.can.checkIn).toBe(true);
      expect(describeToday(home.today)).toMatchObject({ state: 'day_off', headline: 'Holiday', lines: ['Today is a holiday (Christmas Day).', 'If you are working anyway, you can check in: the hours are recorded as work on a day off.'] });

      await punch('employee', 'check-in');
      setNow(CHRISTMAS, '13:00');
      const after = await punch('employee', 'check-out');
      expect(after.day).toMatchObject({ kind: 'holiday', status: 'holiday', workedMinutes: 180, flags: ['worked_on_off_day'], units: null });
      expect(describeToday(after).lines).toEqual(['10:00 to 13:00, 3 h worked.', 'Recorded as work on a day off.']);
      // Divya's calendar has Christmas as an optional holiday, which makes nothing a day off. It is a Friday: her own weekly off.
      expect((await (await person('divya')).get<MyDashboardPayload>('/dashboard/me')).body.today.day).toMatchObject({ kind: 'weekly_off', status: 'weekly_off', holiday: { type: 'optional' } });
      // Imran works the same week as Divya but is on no calendar at all.
      expect((await (await person('imran')).get<MyDashboardPayload>('/dashboard/me')).body.today.day).toMatchObject({ kind: 'weekly_off', holiday: null });
    });
  });

  describe('each person’s own holidays', () => {
    it('are listed from the calendar they were on at each date, and nobody else’s can be asked for', async () => {
      const arjun = await person('employee');
      const mine = (await arjun.get<MyHolidaysPayload>('/holidays/mine?year=2026')).body;
      expect(mine).toMatchObject({ year: 2026, today: CHRISTMAS, calendarName: 'India' });
      // Not Monday the 7th: he was on no calendar that day.
      expect(mine.holidays.map((h) => [h.date, h.name])).toEqual([
        [WED, 'Founders Day'],
        [FRI, 'Regional festival'],
        [SUN, 'Stock-taking'],
        [CHRISTMAS, 'Christmas Day'],
      ]);
      expect(mine.holidays[3]).toEqual({ date: CHRISTMAS, name: 'Christmas Day', type: 'public', description: 'Office closed' });
      // With no year named it is this year.
      expect((await arjun.get<MyHolidaysPayload>('/holidays/mine')).body.year).toBe(2026);
      // The next one is the next one whichever year is being looked at: today, Christmas, while it lasts.
      expect(mine.next).toMatchObject({ date: CHRISTMAS, name: 'Christmas Day' });
      expect((await arjun.get<MyHolidaysPayload>('/holidays/mine?year=2027')).body).toMatchObject({ holidays: [], next: { date: CHRISTMAS } });
      expect((await arjun.get('/holidays/mine?employeeId=x')).status).toBe(400);
      expect((await arjun.get('/holidays/mine?year=2200')).status).toBe(400);

      expect((await (await person('divya')).get<MyHolidaysPayload>('/holidays/mine')).body).toMatchObject({ calendarName: 'UAE office', holidays: [{ date: TUE }, { date: CHRISTMAS, type: 'optional' }] });
      expect((await (await person('kiran')).get<MyHolidaysPayload>('/holidays/mine')).body).toMatchObject({ calendarName: null, holidays: [], next: null });
      expect((await (await person('imran')).get<MyHolidaysPayload>('/holidays/mine')).body).toMatchObject({ calendarName: null, holidays: [] });
      // An employee cannot read a calendar itself: that is for the people who manage them.
      expect((await arjun.get(`/holiday-calendars/${idOfMade('India')}`)).status).toBe(403);
    });

    it('come up on the home page: the next three, from today on', async () => {
      const hr = await as('HR');
      for (const [date, name] of [
        ['2027-01-01', 'New Year’s Day'],
        ['2027-01-26', 'Republic Day'],
        ['2027-05-01', 'May Day'],
      ] as const) expect((await addHoliday('India', date, name)).status).toBe(201);
      const home = (await (await person('employee')).get<MyDashboardPayload>('/dashboard/me')).body;
      expect(home.holidays.calendarName).toBe('India');
      // Today counts as upcoming while it lasts.
      expect(home.holidays.upcoming.map((h) => [h.date, h.name])).toEqual([
        [CHRISTMAS, 'Christmas Day'],
        ['2027-01-01', 'New Year’s Day'],
        ['2027-01-26', 'Republic Day'],
      ]);
      expect((await (await person('kiran')).get<MyDashboardPayload>('/dashboard/me')).body.holidays).toEqual({ calendarName: null, upcoming: [] });
      expect((await hr.get<CalendarDetailPayload>(`/holiday-calendars/${idOfMade('India')}?year=2027`)).body).toMatchObject({ holidayCount: 3, years: [2026, 2027] });
    });
  });

  describe('changing a day that has already begun', () => {
    it('is not done until whoever does it has been shown what it changes', async () => {
      // Tuesday 8 December is long past. On India that day: Arjun, who worked a full day; Fatima and Joseph, who did not come.
      const refused = await addHoliday('India', TUE, 'Surprise holiday');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe(CONFIRM_PAST);
      expect(refused.body.details as HolidayEffect).toEqual({
        people: 3,
        changes: [
          { date: TUE, from: 'absent', to: 'holiday', count: 2 },
          { date: TUE, from: 'present', to: 'holiday', count: 1 },
        ],
      });
      // Nothing was written.
      expect(await mod.db().holidays.countDocuments({ date: TUE, calendarId: idOfMade('India') })).toBe(0);
      expect(await dayOf('employee', TUE)).toMatchObject({ status: 'present' });
      expect(await dayOf('manager', TUE)).toMatchObject({ status: 'absent' });
    });

    it('is done once confirmed, keeps the hours that were worked, and is written to the audit log with its effect', async () => {
      const added = await addHoliday('India', TUE, 'Surprise holiday', 'public', { confirmPast: true });
      expect(added.status).toBe(201);
      expect(await dayOf('manager', TUE)).toMatchObject({ kind: 'holiday', status: 'holiday', units: null });
      expect(await dayOf('employee', TUE)).toMatchObject({ kind: 'holiday', status: 'holiday', workedMinutes: 480, checkInAt: moment(TUE, '09:00'), flags: ['worked_on_off_day'] });
      // The punches themselves are untouched.
      expect((await mod.db().attendanceDays.findOne({ _id: `${await idByKey('employee')}|${TUE}` }))!.history.map((h) => h.kind)).toEqual(['check_in', 'check_out']);
      // People who were not on India that day read as before.
      expect(await dayOf('imran', TUE)).toMatchObject({ status: 'absent' });

      const audit = (await auditOf('holiday.created')).at(-1)!;
      expect(audit.summary).toBe(`Added "Surprise holiday" on ${TUE} to the holiday calendar "India". It changed how 3 days that had already begun read, for 3 people.`);
      expect(audit.actor?.name).toBe('Rahul Nair');
      expect((audit.after as { effect: HolidayEffect }).effect.people).toBe(3);
    });

    it('applies to edits too: a new name changes no day, a new kind or date does', async () => {
      const hr = await as('HR');
      const path = `/holidays/${idOfMade('Surprise holiday')}`;
      const fields = { date: TUE, name: 'Surprise holiday', type: 'public', description: '' };
      // Only the words: no day reads differently, so there is nothing to confirm.
      const renamed = await hr.patch<Holiday>(path, { ...fields, name: 'Thank-you day', description: 'After the audit' });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: 'Thank-you day', description: 'After the audit' });

      // Public to optional makes it a working day again: Arjun's full day counts, the others are absent.
      const retyped = await hr.patch<ErrorPayload>(path, { ...fields, name: 'Thank-you day', type: 'optional' });
      expect(retyped.status).toBe(409);
      expect(retyped.body.details).toEqual({
        people: 3,
        changes: [
          { date: TUE, from: 'holiday', to: 'absent', count: 2 },
          { date: TUE, from: 'holiday', to: 'present', count: 1 },
        ],
      });
      expect((await mod.db().holidays.findOne({ _id: idOfMade('Surprise holiday') }))!.type).toBe('public');

      // Moving it to a day that has not begun still changes the day it leaves.
      const moved = await hr.patch<ErrorPayload>(path, { ...fields, name: 'Thank-you day', date: '2026-12-28' });
      expect(moved.status).toBe(409);
      expect((moved.body.details as HolidayEffect).changes.map((c) => c.date)).toEqual([TUE, TUE]);
      const done = await hr.patch<Holiday>(path, { ...fields, name: 'Thank-you day', date: '2026-12-28', confirmPast: true });
      expect(done.status).toBe(200);
      expect(await dayOf('employee', TUE)).toMatchObject({ kind: 'working', status: 'present', flags: [] });
      expect(await dayOf('manager', TUE)).toMatchObject({ status: 'absent' });
      expect((await auditOf('holiday.updated')).at(-1)).toMatchObject({ before: { date: TUE, name: 'Thank-you day' }, after: { date: '2026-12-28', effect: { people: 3 } } });

      // It cannot be moved onto a date that already has one, and a holiday that is gone cannot be changed.
      expect((await hr.patch<ErrorPayload>(path, { ...fields, date: CHRISTMAS })).body.fields).toEqual({ date: 'That date already has a holiday on this calendar.' });
      expect((await hr.patch('/holidays/hol_000000000000', fields)).status).toBe(404);
      expect((await (await as('Manager')).patch(path, fields)).status).toBe(403);
    });

    it('applies to removing one: the day goes back to what the punches say', async () => {
      const hr = await as('HR');
      const path = `/holidays/${idOfMade('Founders Day')}`;
      expect((await (await as('Employee')).delete(path)).status).toBe(403);
      const refused = await hr.delete<ErrorPayload>(path);
      expect(refused.status).toBe(409);
      // Wednesday the 9th: by then HR was on India as well, so four people; nobody came in.
      expect(refused.body.details).toEqual({ people: 4, changes: [{ date: WED, from: 'holiday', to: 'absent', count: 4 }] });
      expect((await hr.delete(`${path}?confirm=1`)).status).toBe(400);
      expect((await hr.delete(`${path}?confirmPast=1`)).status).toBe(204);
      expect(await dayOf('employee', WED)).toMatchObject({ kind: 'working', status: 'absent', holiday: null });
      expect((await auditOf('holiday.deleted')).at(-1)).toMatchObject({ summary: `Removed "Founders Day" on ${WED} from the holiday calendar "India". It changed how 4 days that had already begun read, for 4 people.`, before: { date: WED, name: 'Founders Day', type: 'company' } });
      expect((await hr.delete(path)).status).toBe(404);

      // One in the future goes without a question.
      expect((await hr.delete(`/holidays/${idOfMade('May Day')}`)).status).toBe(204);
    });
  });

  describe('a calendar and the schedule', () => {
    it('stays with the person when their schedule changes, and the default goes to someone getting their first', async () => {
      const hr = await as('HR');
      const lateShift = (await mod.db().schedules.findOne({ name: 'Late shift 10 to 7' }))!._id;
      const from = '2026-12-28';
      const changed = await hr.post<AssignmentResult>('/schedule-assignments', { employeeIds: [await idByKey('employee'), await idByKey('imran')], scheduleId: lateShift, rules: null, effectiveFrom: from, note: '' });
      expect(changed.body.assigned).toHaveLength(2);
      const assignmentOf = async (key: string) => (await mod.db().scheduleAssignments.findOne({ employeeId: await idByKey(key), effectiveFrom: from }))!;
      // Arjun keeps India. Imran had no calendar and still has none: the default is only for a first schedule.
      expect((await assignmentOf('employee')).holidayCalendarId).toBe(idOfMade('India'));
      expect((await assignmentOf('imran')).holidayCalendarId).toBeNull();

      // Kiran's first schedule: the company default, India.
      await hr.post('/schedule-assignments', { employeeIds: [await idByKey('kiran')], scheduleId: lateShift, rules: null, effectiveFrom: from, note: '' });
      expect((await assignmentOf('kiran')).holidayCalendarId).toBe(idOfMade('India'));

      // A calendar can be named outright, or none at all; one that does not exist is refused.
      const named = await hr.post<AssignmentResult>('/schedule-assignments', { employeeIds: [await idByKey('imran')], scheduleId: lateShift, rules: null, effectiveFrom: from, note: '', holidayCalendarId: idOfMade('UAE') });
      expect(named.body.assigned).toHaveLength(1);
      expect((await assignmentOf('imran')).holidayCalendarId).toBe(idOfMade('UAE'));
      await hr.post('/schedule-assignments', { employeeIds: [await idByKey('kiran')], scheduleId: lateShift, rules: null, effectiveFrom: from, note: '', holidayCalendarId: null });
      expect((await assignmentOf('kiran')).holidayCalendarId).toBeNull();
      expect((await hr.post('/schedule-assignments', { employeeIds: [await idByKey('kiran')], scheduleId: lateShift, rules: null, effectiveFrom: from, note: '', holidayCalendarId: 'cal_000000000000' })).status).toBe(422);

      // Someone new, added with a first schedule, lands on the default as well.
      const added = await hr.post<TemporaryPasswordPayload>('/employees', { name: 'Asha Kurian', email: 'asha.kurian@delta.test', phone: '', role: 'Employee', departmentId: null, designation: '', managerId: null, joinDate: null, schedule: { scheduleId: lateShift, effectiveFrom: from } });
      expect(added.status).toBe(201);
      expect((await mod.db().scheduleAssignments.findOne({ employeeId: added.body.employee.id }))!.holidayCalendarId).toBe(idOfMade('India'));
    });

    it('can be taken away again, from a date', async () => {
      const hr = await as('HR');
      const answer = await give(hr, null, ['joseph'], '2026-12-28');
      expect(answer.body.assigned.map((p) => p.name)).toEqual(['Joseph Mathew']);
      expect((await auditOf('holiday_calendar.assigned')).at(-1)?.summary).toBe('Put Joseph Mathew on no holiday calendar from 2026-12-28.');
      // Until then he is on India: Christmas is still his holiday.
      expect(await dayOf('joseph', CHRISTMAS)).toMatchObject({ status: 'holiday' });
      expect((await mod.db().scheduleAssignments.findOne({ employeeId: await idByKey('joseph'), effectiveFrom: '2026-12-28' }))!.holidayCalendarId).toBeNull();
    });

    it('cannot be deleted once it is part of anyone’s schedule, now or in their history', async () => {
      const hr = await as('HR');
      const inUse = await hr.delete<ErrorPayload>(`/holiday-calendars/${idOfMade('India')}`);
      expect(inUse.status).toBe(409);
      expect(inUse.body.error).toMatch(/has to stay/);

      const scratch = (await hr.post<HolidayCalendar>('/holiday-calendars', { name: 'Scratch' })).body;
      made.set('Scratch', scratch.id);
      await addHoliday('Scratch', '2027-03-03', 'Nothing much');
      expect((await hr.delete(`/holiday-calendars/${scratch.id}`)).status).toBe(204);
      expect(await mod.db().holidays.countDocuments({ calendarId: scratch.id })).toBe(0);
      expect((await hr.get(`/holiday-calendars/${scratch.id}`)).status).toBe(404);
      expect((await auditOf('holiday_calendar.deleted')).at(-1)?.summary).toBe('Deleted the holiday calendar "Scratch", which nobody was ever on, with its 1 holiday.');
    });
  });

  describe('copying a year', () => {
    it('copies date for date into the next year, never writes a day that has begun, and never twice', async () => {
      const hr = await as('HR');
      // 2026 on India now: Monday the 7th, the optional Friday, the working Sunday, Christmas, and the 28th.
      const copied = (await hr.post<CopyYearResult>(`/holiday-calendars/${idOfMade('India')}/copy-year`, { fromYear: 2026 })).body;
      expect(copied.toYear).toBe(2027);
      expect(copied.copied.map((h) => [h.date, h.name, h.type])).toEqual([
        ['2027-12-07', 'Declared after the fact', 'public'],
        ['2027-12-11', 'Regional festival', 'optional'],
        ['2027-12-13', 'Stock-taking', 'special_working_day'],
        ['2027-12-25', 'Christmas Day', 'public'],
        ['2027-12-28', 'Thank-you day', 'public'],
      ]);
      expect(copied.copied[3]).toMatchObject({ description: 'Office closed', createdByName: 'Rahul Nair' });
      expect(copied.skipped).toEqual([]);

      const again = (await hr.post<CopyYearResult>(`/holiday-calendars/${idOfMade('India')}/copy-year`, { fromYear: 2026 })).body;
      expect(again.copied).toEqual([]);
      expect(again.skipped.map((s) => s.reason)).toEqual(Array.from({ length: 5 }, () => 'That date already has a holiday.'));
      expect(await auditOf('holiday_calendar.year_copied')).toHaveLength(1);

      // From 2025 into 2026, with today 25 December 2026: only what is still to come is written.
      const old = (await hr.post<HolidayCalendar>('/holiday-calendars', { name: 'Old' })).body;
      made.set('Old', old.id);
      await addHoliday('Old', '2025-03-01', 'Spring day');
      await addHoliday('Old', '2025-12-26', 'Boxing Day');
      await addHoliday('Old', '2025-12-31', 'Year end');
      const partial = (await hr.post<CopyYearResult>(`/holiday-calendars/${old.id}/copy-year`, { fromYear: 2025 })).body;
      expect(partial.copied.map((h) => h.date)).toEqual(['2026-12-31']);
      expect(partial.skipped.map((s) => [s.date, s.reason])).toEqual([
        ['2026-03-01', 'That date has already begun. Add it by hand, so that what it changes is shown first.'],
        // Tomorrow, the 26th, may already be today for someone further east.
        ['2026-12-26', 'That date has already begun. Add it by hand, so that what it changes is shown first.'],
      ]);
      expect((await hr.post<ErrorPayload>(`/holiday-calendars/${old.id}/copy-year`, { fromYear: 2030 })).status).toBe(422);
      expect((await (await as('Manager')).post(`/holiday-calendars/${old.id}/copy-year`, { fromYear: 2025 })).status).toBe(403);
    });
  });

  describe('the month calendar', () => {
    const monthOf = async (client: Client, query = '') => client.get<AttendanceCalendarPayload & ErrorPayload>(`/attendance/calendar${query}`);

    it('is every day of the month as the engine reads it, with the month added up', async () => {
      const arjun = await person('employee');
      const { status, body } = await monthOf(arjun);
      expect(status).toBe(200);
      expect(body).toMatchObject({ employee: { code: 'EMP-0004', name: 'Arjun Das' }, month: '2026-12', today: CHRISTMAS, timeZone: ZONE });
      expect(body.days).toHaveLength(31);
      expect(body.days.map((d) => d.date)).toEqual(Array.from({ length: 31 }, (_, i) => addDays('2026-12-01', i)));
      expect(body.summary).toEqual(summarize(body.days));

      const read = Object.fromEntries(body.days.map((d) => [d.date, d.status]));
      // Before his first schedule; his one full day; a working Sunday nobody came to; Christmas, worked; days still to come.
      expect([read['2026-12-06'], read[TUE], read[SUN], read[CHRISTMAS], read['2026-12-26'], read['2026-12-27'], read['2026-12-28']]).toEqual(['not_applicable', 'present', 'absent', 'holiday', 'upcoming', 'weekly_off', 'holiday']);
      // Each day is the same as when it is asked for on its own.
      for (const date of [MON, TUE, SUN, CHRISTMAS]) expect(body.days.find((d) => d.date === date)).toEqual(await dayOf('employee', date));
      expect(body.summary).toMatchObject({ presentDays: 1, holidays: 2, offDaysWorked: 1 });
    });

    it('turns at the edges of months and years, and refuses a month that is not one', async () => {
      const arjun = await person('employee');
      for (const [month, days, last] of [
        ['2027-01', 31, '2027-01-31'],
        ['2026-11', 30, '2026-11-30'],
        ['2027-02', 28, '2027-02-28'],
        ['2028-02', 29, '2028-02-29'],
      ] as const) {
        const { body } = await monthOf(arjun, `?month=${month}`);
        expect([body.month, body.days.length, body.days[0]!.date, body.days.at(-1)!.date]).toEqual([month, days, `${month}-01`, last]);
      }
      // November is before his first schedule: nothing applies, and nothing is counted.
      const november = (await monthOf(arjun, '?month=2026-11')).body;
      expect(new Set(november.days.map((d) => d.status))).toEqual(new Set(['not_applicable']));
      expect(november.summary.workingDays).toBe(0);
      // January: New Year's Day and Republic Day are on his calendar.
      expect((await monthOf(arjun, '?month=2027-01')).body.days.filter((d) => d.status === 'holiday').map((d) => d.date)).toEqual(['2027-01-01', '2027-01-26']);

      for (const bad of ['2026-13', '2026-1', '1999-12', '2101-01', 'december', '2026-12-01']) expect((await monthOf(arjun, `?month=${bad}`)).status, bad).toBe(400);
      expect((await monthOf(arjun, '?year=2026')).status).toBe(400);
    });

    it('opens for the person, their managers and HR, and for nobody else', async () => {
      const [arjunId, fatimaId, josephId] = await Promise.all(['employee', 'manager', 'joseph'].map(idByKey));
      const fatima = await person('manager');
      const arjun = await person('employee');

      // Fatima manages Arjun. Joseph reports to the Admin, outside her chain.
      const reports = await monthOf(fatima, `?employeeId=${arjunId}&month=2026-12`);
      expect(reports.status).toBe(200);
      expect(reports.body.employee.name).toBe('Arjun Das');
      expect(reports.body.days.find((d) => d.date === TUE)).toMatchObject({ status: 'present' });

      const outside = await monthOf(fatima, `?employeeId=${josephId}`);
      const nobody = await monthOf(fatima, '?employeeId=emp_000000000000');
      expect([outside.status, nobody.status]).toEqual([404, 404]);
      // Word for word the same, so an id cannot be probed.
      expect(outside.body).toEqual(nobody.body);

      expect((await monthOf(arjun, `?employeeId=${fatimaId}`)).status).toBe(404);
      expect((await monthOf(arjun, `?employeeId=${arjunId}`)).status).toBe(200);
      for (const role of ['HR', 'Admin'] as const) expect((await monthOf(await as(role), `?employeeId=${josephId}`)).body.employee.name).toBe('Joseph Mathew');
      expect((await monthOf(new Client())).status).toBe(401);
    });
  });
});
