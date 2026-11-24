/*
 * End-to-end tests of the employee's home page (Phase 4) against a real MongoDB. The tests
 * set the server's clock, walk people through a week, and then ask for the dashboard. What
 * each state reads as is tested exhaustively in shared/src/today.test.ts; here it is that the
 * one answer adds up the way the engine does, belongs to the caller alone, and gives the
 * page's timer what it needs to count exactly as the server will.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  describeToday,
  liveDay,
  summarize,
  zonedToInstant,
  type DayDetailPayload,
  type DayResult,
  type ErrorPayload,
  type MyDashboardPayload,
  type PeriodSummary,
  type TodayPayload,
} from '@delta-hrms/shared';
import { boot, Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

const ZONE = 'Asia/Kolkata';
/** Monday 7 December 2026, the day the sample company is created, and the days after it. */
const MON = '2026-12-07';
const day = (n: number) => addDays(MON, n);
const [TUE, WED, FRI, SAT, SUN, NEXT_MON] = [day(1), day(2), day(4), day(5), day(6), day(7)];

/** The moment the wall clock in India shows a time ("09:00" or "09:00:30") on a day. */
const moment = (date: string, time: string) => new Date(zonedToInstant(date, time.slice(0, 5), ZONE).getTime() + Number(time.slice(6) || 0) * 1000).toISOString();
const setNow = (date: string, time: string) => mod.clock.setTestNow(moment(date, time));

beforeAll(async () => {
  await boot('dashboard');
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

const punch = async (client: Client, action: 'check-in' | 'check-out' | 'break/start' | 'break/end') => {
  const answer = await client.post<TodayPayload & ErrorPayload>(`/attendance/${action}`);
  expect(answer.status, `${action}: ${answer.body?.error ?? ''}`).toBe(200);
  return answer.body;
};
const dashboard = async (client: Client) => {
  const answer = await client.get<MyDashboardPayload>('/dashboard/me');
  expect(answer.status).toBe(200);
  return answer.body;
};

/** Present + half-days ÷ 2 + leave + absent + unresolved: always the working days. */
const accountedFor = (s: PeriodSummary) => s.presentDays + s.halfDays / 2 + s.leaveDays + s.absentDays + s.unresolvedDays;

describe.skipIf(!reachable)('the employee’s home page', () => {
  it('starts with nothing counted: a day that has not begun adds no numbers', async () => {
    const arjun = await person('employee');
    setNow(MON, '08:30');
    const home = await dashboard(arjun);
    expect(home.today).toMatchObject({ today: MON, timeZone: ZONE, can: { checkIn: true, checkOut: false }, day: { date: MON, status: 'not_due' } });
    expect(home.month).toMatchObject({ from: '2026-12-01', to: MON });
    expect(home.month.summary).toEqual({ workingDays: 0, presentDays: 0, halfDays: 0, leaveDays: 0, unpaidLeaveDays: 0, absentDays: 0, unresolvedDays: 0, lateEntries: 0, earlyDepartures: 0, correctedDays: 0, holidays: 0, weeklyOffs: 0, offDaysWorked: 0, workedMinutes: 0 });
    // The days before their first schedule do not apply to them, so there is nothing recent to list.
    expect(home.recent).toEqual([]);
  });

  it('adds up a week exactly as the engine does for the same days', async () => {
    const arjun = await person('employee');
    const arjunId = await idByKey('employee');

    // Monday: a full day. Tuesday: late, and a full day. Wednesday: left at 14:00, a half-day.
    // Thursday: never came. Friday: checked in and forgot to check out. Saturday: a full day.
    for (const [date, inAt, outAt] of [
      [MON, '08:55', '18:05'],
      [TUE, '09:30', '18:30'],
      [WED, '09:00', '14:00'],
      [FRI, '09:00', null],
      [SAT, '09:00', '18:00'],
    ] as const) {
      setNow(date, inAt);
      await punch(arjun, 'check-in');
      if (!outAt) continue;
      setNow(date, outAt);
      await punch(arjun, 'check-out');
    }

    setNow(NEXT_MON, '10:00');
    const home = await dashboard(arjun);

    expect(home.month).toMatchObject({ from: '2026-12-01', to: NEXT_MON });
    expect(home.month.summary).toEqual({
      workingDays: 6,
      presentDays: 3,
      halfDays: 1,
      leaveDays: 0,
      unpaidLeaveDays: 0,
      // Thursday, and the missing half of Wednesday.
      absentDays: 1.5,
      unresolvedDays: 1,
      lateEntries: 1,
      earlyDepartures: 1,
      correctedDays: 0,
      holidays: 0,
      weeklyOffs: 1,
      offDaysWorked: 0,
      // 8 h 10 + 8 h + 5 h + 8 h. Friday has no known length, so it adds nothing.
      workedMinutes: 490 + 480 + 300 + 480,
    });
    expect(accountedFor(home.month.summary)).toBe(home.month.summary.workingDays);

    // The same days, read one at a time and added up by the engine: the same numbers.
    const days: DayResult[] = [];
    for (let date = '2026-12-01'; date <= NEXT_MON; date = addDays(date, 1)) {
      const answer = await arjun.get<DayDetailPayload>(`/attendance/days/${arjunId}/${date}`);
      expect(answer.status).toBe(200);
      days.push(answer.body.day);
    }
    expect(summarize(days)).toEqual(home.month.summary);

    // Recent days: the seven before today, newest first, each as the engine reads it.
    expect(home.recent.map((d) => [d.date, d.status])).toEqual([
      [SUN, 'weekly_off'],
      [SAT, 'present'],
      [FRI, 'unresolved'],
      [day(3), 'absent'],
      [WED, 'half_day'],
      [TUE, 'present'],
      [MON, 'present'],
    ]);
    expect(home.recent).toEqual(days.filter((d) => d.date >= MON && d.date < NEXT_MON).reverse());

    // Today itself is not in either: it is past the grace with nobody in, and can still be started.
    expect(home.today).toMatchObject({ today: NEXT_MON, can: { checkIn: true }, day: { date: NEXT_MON, status: 'not_in' } });
    expect(describeToday(home.today).lines).toEqual(['Your day started at 09:00. Checking in now is a late entry.']);
  });

  it('counts today in the month only once it is checked out', async () => {
    const arjun = await person('employee');
    setNow(NEXT_MON, '10:00');
    const afterCheckIn = await punch(arjun, 'check-in');
    expect(afterCheckIn.day).toMatchObject({ status: 'working', lateMinutes: 60 });

    setNow(NEXT_MON, '15:00');
    const during = await dashboard(arjun);
    expect(during.today.day).toMatchObject({ status: 'working', grossMinutes: 300, workedMinutes: 300 });
    // Open: the late entry is already a fact, the day and its hours are not counted yet.
    expect(during.month.summary).toMatchObject({ workingDays: 6, presentDays: 3, lateEntries: 2, workedMinutes: 1750 });
    expect(during.recent[0]).toMatchObject({ date: SUN });

    setNow(NEXT_MON, '18:30');
    await punch(arjun, 'check-out');
    const after = await dashboard(arjun);
    // 10:00 to 18:30 is 8 h 30, less the hour's break: 7 h 30, exactly a full day.
    expect(after.today.day).toMatchObject({ status: 'present', workedMinutes: 450 });
    expect(after.month.summary).toMatchObject({ workingDays: 7, presentDays: 4, lateEntries: 2, workedMinutes: 2200 });
    expect(accountedFor(after.month.summary)).toBe(7);
    // The Today card's day is never repeated under "Recent days".
    expect(after.recent.map((d) => d.date)).not.toContain(NEXT_MON);
  });

  it('gives the page’s timer what it needs to count exactly as the server will', async () => {
    // Sneha works flexible hours and records her breaks.
    const sneha = await person('sneha');
    setNow(NEXT_MON, '10:00:20');
    await punch(sneha, 'check-in');
    setNow(NEXT_MON, '13:00');
    await punch(sneha, 'break/start');
    setNow(NEXT_MON, '13:20:45');
    await punch(sneha, 'break/end');

    setNow(NEXT_MON, '15:00:30');
    const asked = (await dashboard(sneha)).today;
    expect(asked.dayRules?.name).toBe('Flexible 8 hours');
    expect(asked.hours).toMatchObject({ fullDayMinutes: 480, halfDayMinutes: 240 });
    expect(asked.breaks).toEqual([{ startAt: moment(NEXT_MON, '13:00'), endAt: moment(NEXT_MON, '13:20:45') }]);
    // At the moment of the answer the timer and the server say the same.
    expect(liveDay(asked, asked.serverNow)).toMatchObject({ grossMinutes: asked.day.grossMinutes, breakMinutes: 20, workedMinutes: 280, moving: true, seconds: 30, wouldCountAs: 'half_day' });

    // Later, with no newer answer, the timer has moved on by itself. Ask the server: the same again.
    for (const time of ['15:47:10', '18:19:59', '18:20:00', '21:05:00']) {
      setNow(NEXT_MON, time);
      const later = (await dashboard(sneha)).today.day;
      const timer = liveDay(asked, moment(NEXT_MON, time))!;
      expect([time, timer.grossMinutes, timer.breakMinutes, timer.workedMinutes]).toEqual([time, later.grossMinutes, later.breakMinutes, later.workedMinutes]);
    }
    // 8 hours of work are complete at 18:20: ten o'clock, plus eight hours, plus the twenty-minute break.
    expect(liveDay(asked, moment(NEXT_MON, '18:19:59'))!.wouldCountAs).toBe('half_day');
    expect(liveDay(asked, moment(NEXT_MON, '18:20:00'))!.wouldCountAs).toBe('present');

    setNow(NEXT_MON, '18:20');
    expect((await punch(sneha, 'check-out')).day).toMatchObject({ status: 'present', workedMinutes: 480 });
  });

  it('shows someone with no schedule that nothing is counted, with no numbers made up', async () => {
    const kiran = await person('kiran');
    setNow(NEXT_MON, '10:00');
    const home = await dashboard(kiran);
    expect(home.today).toMatchObject({ rules: null, dayRules: null, hours: null, can: { checkIn: false, checkOut: false, startBreak: false, endBreak: false }, day: { status: 'not_applicable' } });
    expect(describeToday(home.today).state).toBe('no_schedule');
    expect(home.month.summary).toMatchObject({ workingDays: 0, presentDays: 0, absentDays: 0, workedMinutes: 0 });
    expect(home.recent).toEqual([]);
  });

  it('is only ever the caller’s own: there is no way to ask for someone else', async () => {
    const fatima = await person('manager');
    const arjunId = await idByKey('employee');
    setNow(NEXT_MON, '19:00');

    // Fatima manages Arjun and may read his days, but the home page takes no employee at all.
    for (const query of [`?employeeId=${arjunId}`, '?month=2026-11', '?id=1']) {
      const refused = await fatima.get<ErrorPayload>(`/dashboard/me${query}`);
      expect(refused.status, query).toBe(400);
    }
    const hers = await dashboard(fatima);
    const his = await dashboard(await person('employee'));
    // She never checked in this week; he did. Each sees their own.
    expect(hers.month.summary).toMatchObject({ presentDays: 0, workedMinutes: 0 });
    expect(his.month.summary).toMatchObject({ presentDays: 4, workedMinutes: 2200 });

    const nobody = await new Client().get<ErrorPayload>('/dashboard/me');
    expect(nobody.status).toBe(401);
  });

  it('starts the count again in a new month, while recent days still reach back into the old one', async () => {
    const arjun = await person('employee');
    // Saturday 2 January 2027. Friday the 1st was a working day and nobody came.
    mod.clock.setTestNow(moment('2027-01-02', '10:00'));
    const home = await dashboard(arjun);
    expect(home.month).toMatchObject({ from: '2027-01-01', to: '2027-01-02' });
    expect(home.month.summary).toMatchObject({ workingDays: 1, presentDays: 0, absentDays: 1, workedMinutes: 0 });
    expect(home.recent.map((d) => d.date)).toEqual(['2027-01-01', '2026-12-31', '2026-12-30', '2026-12-29', '2026-12-28', '2026-12-27', '2026-12-26']);
    expect(home.recent.find((d) => d.date === '2026-12-27')).toMatchObject({ status: 'weekly_off' });
  });

  it('reads the optional sample history like any other punches: it is facts, and the engine judges them', async () => {
    // A fresh sample company with three weeks behind it, as `npm run seed -- --history` makes it.
    mod.clock.setTestNow(moment('2026-12-21', '08:00'));
    await Promise.all(Object.values(mod.db()).map((collection) => (collection as { deleteMany: (filter: object) => Promise<unknown> }).deleteMany({})));
    expect(await mod.seed.seedDemo({ historyDays: 21 })).toBe(true);
    clients.clear();

    const readDays = async (client: Client, id: string) => {
      const days: DayResult[] = [];
      for (let date = '2026-11-30'; date <= '2026-12-20'; date = addDays(date, 1)) days.push((await client.get<DayDetailPayload>(`/attendance/days/${id}/${date}`)).body.day);
      return days;
    };

    // Arjun, Monday to Saturday: eighteen working days, mostly full, with one of each thing that goes wrong.
    const arjun = await person('employee');
    const days = await readDays(arjun, await idByKey('employee'));
    const total = summarize(days);
    expect(total).toMatchObject({ workingDays: 18, presentDays: 13, halfDays: 1, absentDays: 2.5, unresolvedDays: 2, lateEntries: 1, earlyDepartures: 1, weeklyOffs: 3 });
    expect(accountedFor(total)).toBe(18);
    // Nothing that is a judgement was written by the seed.
    const stored = await mod.db().attendanceDays.find({ employeeId: await idByKey('employee') }).toArray();
    expect(stored).toHaveLength(16);
    for (const doc of stored) for (const field of ['status', 'flags', 'units', 'workedMinutes']) expect(doc).not.toHaveProperty(field);

    const home = await dashboard(arjun);
    expect(home.today.day).toMatchObject({ date: '2026-12-21', status: 'not_due' });
    expect(home.recent.map((d) => d.status)).toEqual(['weekly_off', 'absent', 'present', 'present', 'unresolved', 'present', 'present']);
    expect(accountedFor(home.month.summary)).toBe(home.month.summary.workingDays);

    // The other schedules too: a different week (Friday off), and flexible hours with recorded breaks.
    for (const key of ['divya', 'sneha']) {
      const theirs = summarize(await readDays(await person(key), await idByKey(key)));
      expect(accountedFor(theirs), key).toBe(theirs.workingDays);
      expect(theirs.presentDays, key).toBeGreaterThanOrEqual(9);
      expect(theirs.halfDays, key).toBeGreaterThanOrEqual(1);
    }
    const sneha = await mod.db().attendanceDays.findOne({ employeeId: await idByKey('sneha'), checkOutAt: { $ne: null } });
    expect(sneha!.breaks).toHaveLength(1);
    expect(sneha!.history.map((h) => h.kind)).toEqual(['check_in', 'break_start', 'break_end', 'check_out']);
  });
});
