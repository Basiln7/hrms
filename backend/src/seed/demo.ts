import { addDays, exampleA, exampleB, exampleC, HOLIDAY_TYPE_INFO, localDateOf, type CompanySettings, type EmploymentPeriod, type Holiday, type HolidayCalendar, type HolidayType, type LocalDate, type Role, type Schedule, type ScheduleAssignment, type ScheduleRules } from '@delta-hrms/shared';
import { hashPassword } from '../auth/passwords';
import { clock } from '../clock';
import { config } from '../config';
import { db, nameKey, toDoc, type Account, type AttendanceDayDoc } from '../db';
import { newId } from '../ids';
import { seedAnnouncements } from './announcements';
import { sampleHistory } from './history';
import { seedLeaveRequests, seedLeaveSetup } from './leave';
import { rebuildAdmins } from '../services/admins';
import { saveDefaultCalendar } from '../services/calendarStore';
import { reserveEmployeeCodes } from '../services/employees';
import { saveCompany } from '../services/settings';

/*
 * A sample company for development and for the automated tests. It is never created by the
 * server itself, only by `npm run seed`, and it refuses to run in production.
 *
 * It has one person per role (the four the tests sign in as), a new joiner who still holds a
 * temporary password, and enough other people to make the lists worth looking at: three
 * departments, two levels of management, the brief's three schedules, someone with a schedule
 * that has not started yet, someone with none, and someone who has left.
 */

/** The password of every sample account. Development only. */
export const DEMO_PASSWORD = 'delta-hrms-demo';

export const DEMO_COMPANY: CompanySettings = { name: 'Delta (sample)', timeZone: 'Asia/Kolkata', weekStartsOn: 'monday', leaveYearStartMonth: 1 };

export const DEMO_DEPARTMENTS = ['Sales', 'Operations', 'Support'] as const;
type DepartmentName = (typeof DEMO_DEPARTMENTS)[number];

/** The brief's three employees, as the sample company's standard schedules. */
const DEMO_SCHEDULES: Record<'A' | 'B' | 'C', (zone: string) => ScheduleRules> = { A: exampleA, B: exampleB, C: exampleC };

interface DemoPerson {
  key: string;
  name: string;
  email: string;
  role: Role;
  designation: string;
  department: DepartmentName;
  managerKey?: string;
  /** Created by HR and not signed in yet, still on a temporary password. */
  invited?: boolean;
  /** Which schedule they are on, and how many days from today it starts (0 = today). */
  schedule?: { on: 'A' | 'B' | 'C'; inDays: number };
  /** Someone who worked here between these dates and has left. */
  left?: { from: LocalDate; to: LocalDate };
}

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  { key: 'admin', name: 'Anita Menon', email: 'admin@delta.test', role: 'Admin', designation: 'Operations Director', department: 'Operations', schedule: { on: 'A', inDays: 0 } },
  { key: 'hr', name: 'Rahul Nair', email: 'hr@delta.test', role: 'HR', designation: 'HR Executive', department: 'Operations', schedule: { on: 'A', inDays: 0 } },
  { key: 'manager', name: 'Fatima Khan', email: 'manager@delta.test', role: 'Manager', designation: 'Sales Manager', department: 'Sales', schedule: { on: 'A', inDays: 0 } },
  { key: 'employee', name: 'Arjun Das', email: 'employee@delta.test', role: 'Employee', designation: 'Sales Executive', department: 'Sales', managerKey: 'manager', schedule: { on: 'A', inDays: 0 } },
  { key: 'newjoiner', name: 'Meera Pillai', email: 'newjoiner@delta.test', role: 'Employee', designation: 'Trainee', department: 'Sales', managerKey: 'manager', invited: true, schedule: { on: 'A', inDays: 7 } },
  { key: 'lead', name: 'Vivek Sharma', email: 'vivek.sharma@delta.test', role: 'Manager', designation: 'Team Lead', department: 'Sales', managerKey: 'manager', schedule: { on: 'B', inDays: 0 } },
  { key: 'divya', name: 'Divya Thomas', email: 'divya.thomas@delta.test', role: 'Employee', designation: 'Sales Executive', department: 'Sales', managerKey: 'lead', schedule: { on: 'B', inDays: 0 } },
  { key: 'imran', name: 'Imran Sheikh', email: 'imran.sheikh@delta.test', role: 'Employee', designation: 'Business Development Executive', department: 'Sales', managerKey: 'lead', schedule: { on: 'B', inDays: 0 } },
  { key: 'sneha', name: 'Sneha Iyer', email: 'sneha.iyer@delta.test', role: 'Employee', designation: 'Designer', department: 'Operations', managerKey: 'admin', schedule: { on: 'C', inDays: 0 } },
  { key: 'joseph', name: 'Joseph Mathew', email: 'joseph.mathew@delta.test', role: 'Employee', designation: 'Accountant', department: 'Operations', managerKey: 'admin', schedule: { on: 'A', inDays: 0 } },
  { key: 'nisha', name: 'Nisha Varma', email: 'nisha.varma@delta.test', role: 'Manager', designation: 'Support Manager', department: 'Support', schedule: { on: 'A', inDays: 0 } },
  { key: 'kiran', name: 'Kiran Babu', email: 'kiran.babu@delta.test', role: 'Employee', designation: 'Support Executive', department: 'Support', managerKey: 'nisha' },
  { key: 'leela', name: 'Leela George', email: 'leela.george@delta.test', role: 'Employee', designation: 'Support Executive', department: 'Support', managerKey: 'nisha', left: { from: '2026-03-02', to: '2026-10-30' } },
];

/** The sample company's holiday calendar: holidays that fall on the same date every year, so the sample works in any year. */
export const DEMO_CALENDAR = 'Delta holidays';
export const DEMO_HOLIDAYS: readonly { day: string; name: string; type: HolidayType; description?: string }[] = [
  { day: '01-01', name: 'New Year’s Day', type: 'company' },
  { day: '01-26', name: 'Republic Day', type: 'public' },
  { day: '05-01', name: 'May Day', type: 'public' },
  { day: '08-15', name: 'Independence Day', type: 'public' },
  { day: '10-02', name: 'Gandhi Jayanti', type: 'public' },
  { day: '11-01', name: 'Kerala Piravi', type: 'optional', description: 'Take leave if you would like the day off.' },
  { day: '12-25', name: 'Christmas Day', type: 'public' },
];

export interface SeedOptions {
  /**
   * Give the sample company a holiday calendar (see DEMO_HOLIDAYS), make it the company
   * default and put everyone on it. `npm run seed` asks for it. The tests leave it out and
   * make the holidays they need through the API.
   */
  holidays?: boolean;
  /**
   * Give the sample company a past: everyone whose schedule starts today has had it for this
   * many days instead, with sample attendance for each of them (see history.ts). 0 for none.
   */
  historyDays?: number;
  /**
   * Give the sample company leave (see leave.ts): four kinds, one policy with everyone on it,
   * joining dates, and a few requests. `npm run seed` asks for it. The tests leave it out and
   * set up the leave they need through the API.
   */
  leave?: boolean;
  /** Give the sample company a few announcements (see announcements.ts), posted by HR. `npm run seed` asks for them. */
  announcements?: boolean;
}

/** Fills an empty database with the sample company. Returns false, changing nothing, when anyone already exists. */
export async function seedDemo({ historyDays = 0, holidays = false, leave = false, announcements = false }: SeedOptions = {}): Promise<boolean> {
  if (config.isProduction) throw new Error('The sample company is for development and cannot be created in production.');
  if ((await db().employees.estimatedDocumentCount()) > 0) return false;

  const zone = DEMO_COMPANY.timeZone;
  const now = clock.nowIso();
  const today = localDateOf(clock.now(), zone);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const departments = new Map(DEMO_DEPARTMENTS.map((name) => [name, newId('dep')]));
  await db().departments.insertMany([...departments].map(([name, id]) => ({ _id: id, name, nameKey: nameKey(name), createdAt: now })));

  const schedules = new Map<string, Schedule>();
  for (const [key, make] of Object.entries(DEMO_SCHEDULES)) {
    const rules = make(zone);
    schedules.set(key, { id: newId('sch'), name: rules.name, rules, archived: false, createdAt: now, updatedAt: now });
  }
  await db().schedules.insertMany([...schedules.values()].map((s) => ({ ...toDoc(s), nameKey: nameKey(s.name) })));

  const ids = new Map(DEMO_PEOPLE.map((p) => [p.key, newId('emp')]));
  const adminId = ids.get('admin')!;

  // The holiday calendar, for last year, this year and next, so that there is always a past and a next holiday.
  const calendar: HolidayCalendar | null = holidays ? { id: newId('cal'), name: DEMO_CALENDAR, createdAt: now, updatedAt: now } : null;
  const year = Number(today.slice(0, 4));
  const holidayList: Holiday[] = calendar
    ? [year - 1, year, year + 1].flatMap((y) => DEMO_HOLIDAYS.map((h) => ({ id: newId('hol'), calendarId: calendar.id, date: `${y}-${h.day}`, name: h.name, type: h.type, description: h.description ?? '', createdBy: adminId, createdByName: 'Anita Menon', createdAt: now, updatedAt: now })))
    : [];
  const daysOff = new Set(holidayList.filter((h) => HOLIDAY_TYPE_INFO[h.type].dayOff).map((h) => h.date));
  const leavePolicyId = leave ? await seedLeaveSetup() : null;
  /** With leave, people have a joining date: one to three years back, or the day their schedule starts for someone still to join. */
  const joinedOn = (p: DemoPerson, index: number): LocalDate | null => (!leave ? null : p.schedule && p.schedule.inDays > 0 ? addDays(today, p.schedule.inDays) : `${year - 1 - (index % 3)}-${String((index % 9) + 1).padStart(2, '0')}-15`);
  const assignments: ScheduleAssignment[] = [];
  const history: AttendanceDayDoc[] = [];
  const accounts: Account[] = DEMO_PEOPLE.map((p, index) => {
    const id = ids.get(p.key)!;
    let employment: EmploymentPeriod[] = [];
    const assign = (on: 'A' | 'B' | 'C', effectiveFrom: LocalDate) => {
      const schedule = schedules.get(on)!;
      const assignment: ScheduleAssignment = { id: newId('asg'), employeeId: id, effectiveFrom, scheduleId: schedule.id, rules: schedule.rules, holidayCalendarId: calendar?.id ?? null, note: '', createdBy: adminId, createdByName: 'Anita Menon', createdAt: now };
      assignments.push(assignment);
      return assignment;
    };
    if (p.left) {
      // Sample history: written directly, as if they had been in the HRMS at the time.
      assign('A', p.left.from);
      employment = [{ from: p.left.from, to: p.left.to }];
    } else if (p.schedule) {
      // With a past asked for, a schedule that would start today started that many days ago.
      const past = historyDays > 0 && p.schedule.inDays === 0;
      const from = addDays(today, past ? -historyDays : p.schedule.inDays);
      const assignment = assign(p.schedule.on, from);
      employment = [{ from, to: null }];
      if (past) history.push(...sampleHistory({ id, name: p.name, index }, assignment, from, today, daysOff));
    }
    return {
      id,
      code: `EMP-${String(index + 1).padStart(4, '0')}`,
      name: p.name,
      email: p.email,
      phone: '',
      role: p.role,
      departmentId: departments.get(p.department)!,
      designation: p.designation,
      managerId: p.managerKey ? ids.get(p.managerKey)! : null,
      joinDate: p.left?.from ?? joinedOn(p, index),
      employment,
      status: p.left ? 'inactive' : p.invited ? 'invited' : 'active',
      leavePolicyId: p.left ? null : leavePolicyId,
      mustChangePassword: Boolean(p.invited),
      createdAt: now,
      updatedAt: now,
      passwordHash,
    };
  });
  await db().employees.insertMany(accounts.map(toDoc));
  await db().scheduleAssignments.insertMany(assignments.map(toDoc));
  if (history.length > 0) await db().attendanceDays.insertMany(history);
  if (calendar) {
    await db().holidayCalendars.insertOne({ ...toDoc(calendar), nameKey: nameKey(calendar.name) });
    await db().holidays.insertMany(holidayList.map(toDoc));
    await saveDefaultCalendar(calendar.id);
  }
  await saveCompany(DEMO_COMPANY);
  await reserveEmployeeCodes(accounts.length);
  await rebuildAdmins();
  if (leave) await seedLeaveRequests((key) => ids.get(key)!, today, historyDays > 0);
  if (announcements) await seedAnnouncements({ id: ids.get('hr')!, name: DEMO_PEOPLE.find((p) => p.key === 'hr')!.name }, departments);
  return true;
}
