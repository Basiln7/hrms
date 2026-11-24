import { MongoClient, type Collection } from 'mongodb';
import type { AccountEntry, Announcement, AttendanceBreak, AttendanceHistoryEntry, AuditEvent, CorrectionRequest, Department, Employee, Holiday, HolidayCalendar, LeaveBooking, LeavePolicy, LeaveRequest, LeaveType, LocalDate, Schedule, ScheduleAssignment } from '@delta-hrms/shared';

/** How a record is stored: the app's `id` is MongoDB's `_id`, so ids are unique by construction. */
export type Doc<T extends { id: string }> = Omit<T, 'id'> & { _id: string };

/** An employee as the server knows them. `passwordHash` never leaves this process. */
export type Account = Employee & { passwordHash: string };

export interface SessionDoc {
  /** SHA-256 of the cookie token, so a database leak does not hand out usable sessions. */
  _id: string;
  employeeId: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Single-document settings.
 * - `company`: the company settings.
 * - `admins`: the ids of the Admins who are not deactivated. The guard for "never the last one".
 * - `counters`: the last employee code handed out.
 * - `holidays`: which holiday calendar is preselected for people getting their first schedule.
 * - `leave`: which leave policy people are put on as they are added.
 */
export interface MetaDoc {
  _id: 'company' | 'admins' | 'counters' | 'holidays' | 'leave';
  value: unknown;
}

/** A name as it is compared: without case or extra spaces, so "Sales" and " sales " are one name. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export type DepartmentDoc = Doc<Department> & { nameKey: string };
export type ScheduleDoc = Doc<Schedule> & { nameKey: string };
export type HolidayCalendarDoc = Doc<HolidayCalendar> & { nameKey: string };
export type LeaveTypeDoc = Doc<LeaveType> & { nameKey: string };
export type LeavePolicyDoc = Doc<LeavePolicy> & { nameKey: string };

/**
 * One person's leave for one leave year. `_id` is "<employeeId>|<leaveYear>", so there is one
 * document per person per year, and every balance check, overlap check and hold of days is one
 * write to it. No balance is stored: it is worked out from the two lists.
 */
export interface LeaveAccountDoc {
  _id: string;
  employeeId: string;
  leaveYear: number;
  entries: AccountEntry[];
  bookings: LeaveBooking[];
  carried: boolean;
  /** Goes up with every write. A write names the version it read. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** A history entry as it is stored: with where the request came from, which only the audit needs. */
export type StoredHistoryEntry = AttendanceHistoryEntry & { ip?: string; userAgent?: string };

/**
 * The facts of one person's one day. `_id` is "<employeeId>|<date>", so there can only ever be
 * one document per person per day. No status is stored: it is worked out from these facts.
 */
export interface AttendanceDayDoc {
  _id: string;
  employeeId: string;
  date: LocalDate;
  /** The assignment the day was punched under. Null while nothing has been punched. */
  assignmentId: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  breaks: AttendanceBreak[];
  override: 'present' | 'half_day' | null;
  lateExcused: boolean;
  /** HR's note on the day (Phase 6). */
  note: { text: string; by: string; byName: string; at: string } | null;
  history: StoredHistoryEntry[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** "This person has opened this announcement." `_id` is "<announcementId>|<employeeId>", so there is one per person per announcement. */
export interface AnnouncementReadDoc {
  _id: string;
  announcementId: string;
  employeeId: string;
  readAt: string;
}

export const attendanceId = (employeeId: string, date: LocalDate) => `${employeeId}|${date}`;

export interface Collections {
  employees: Collection<Doc<Account>>;
  departments: Collection<DepartmentDoc>;
  /** Standard schedules: named sets of rules that can be given to many people. */
  schedules: Collection<ScheduleDoc>;
  /** The rules each person works under from a date. A frozen copy; never edited once it has started. */
  scheduleAssignments: Collection<Doc<ScheduleAssignment>>;
  attendanceDays: Collection<AttendanceDayDoc>;
  /** Named sets of holidays. A person is on one through their schedule assignment. */
  holidayCalendars: Collection<HolidayCalendarDoc>;
  holidays: Collection<Doc<Holiday>>;
  /** Requests to correct a day. The request's status is the truth; the day is made to match it. */
  corrections: Collection<Doc<CorrectionRequest>>;
  leaveTypes: Collection<LeaveTypeDoc>;
  leavePolicies: Collection<LeavePolicyDoc>;
  /** The one document every balance and overlap check goes through. */
  leaveAccounts: Collection<LeaveAccountDoc>;
  /** Requests for time off. The request's status is the truth; the account is made to match it. */
  leaveRequests: Collection<Doc<LeaveRequest>>;
  announcements: Collection<Doc<Announcement>>;
  announcementReads: Collection<AnnouncementReadDoc>;
  sessions: Collection<SessionDoc>;
  meta: Collection<MetaDoc>;
  /** Every HR and admin action. Only ever added to. */
  audit: Collection<Doc<AuditEvent>>;
}

let client: MongoClient | null = null;
let collections: Collections | null = null;

export async function connect(uri: string, dbName: string): Promise<Collections> {
  // `ignoreUndefined` keeps optional fields out of the document instead of storing them as null.
  client = new MongoClient(uri, { ignoreUndefined: true, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const database = client.db(dbName);
  collections = {
    employees: database.collection('employees'),
    departments: database.collection('departments'),
    schedules: database.collection('schedules'),
    scheduleAssignments: database.collection('schedule_assignments'),
    attendanceDays: database.collection('attendance_days'),
    holidayCalendars: database.collection('holiday_calendars'),
    holidays: database.collection('holidays'),
    corrections: database.collection('regularization_requests'),
    leaveTypes: database.collection('leave_types'),
    leavePolicies: database.collection('leave_policies'),
    leaveAccounts: database.collection('leave_accounts'),
    leaveRequests: database.collection('leave_requests'),
    announcements: database.collection('announcements'),
    announcementReads: database.collection('announcement_reads'),
    sessions: database.collection('sessions'),
    meta: database.collection('meta'),
    audit: database.collection('audit'),
  };
  await Promise.all([
    // One account per email, one code per person. First-run setup inserts EMP-0001, so it can succeed only once.
    collections.employees.createIndex({ email: 1 }, { unique: true }),
    collections.employees.createIndex({ code: 1 }, { unique: true }),
    collections.employees.createIndex({ managerId: 1 }),
    collections.employees.createIndex({ departmentId: 1 }),
    collections.employees.createIndex({ status: 1 }),
    collections.employees.createIndex({ leavePolicyId: 1 }),
    // The employee list is shown by name: a page of it is read in that order.
    collections.employees.createIndex({ name: 1, _id: 1 }),
    // No two kinds of leave with the same code or name, and no two policies with the same name.
    collections.leaveTypes.createIndex({ code: 1 }, { unique: true }),
    collections.leaveTypes.createIndex({ nameKey: 1 }, { unique: true }),
    collections.leavePolicies.createIndex({ nameKey: 1 }, { unique: true }),
    // A person's accounts, oldest first (the previous year is what is carried forward from).
    collections.leaveAccounts.createIndex({ employeeId: 1, leaveYear: 1 }),
    // A person's leave in date order and newest first; the approvals inbox; "who is on leave on day D".
    collections.leaveRequests.createIndex({ employeeId: 1, startDate: 1 }),
    collections.leaveRequests.createIndex({ employeeId: 1, submittedAt: -1, _id: -1 }),
    collections.leaveRequests.createIndex({ status: 1, submittedAt: 1, _id: 1 }),
    collections.leaveRequests.createIndex({ status: 1, startDate: 1, endDate: 1 }),
    // No two departments, and no two standard schedules, with the same name.
    collections.departments.createIndex({ nameKey: 1 }, { unique: true }),
    collections.schedules.createIndex({ nameKey: 1 }, { unique: true }),
    // One set of rules per person per start date; "the rules on date D" is one indexed lookup.
    collections.scheduleAssignments.createIndex({ employeeId: 1, effectiveFrom: 1 }, { unique: true }),
    collections.scheduleAssignments.createIndex({ scheduleId: 1 }),
    // Who is, or ever was, on a holiday calendar.
    collections.scheduleAssignments.createIndex({ holidayCalendarId: 1 }),
    // No two calendars with the same name, and one holiday per calendar per day.
    collections.holidayCalendars.createIndex({ nameKey: 1 }, { unique: true }),
    collections.holidays.createIndex({ calendarId: 1, date: 1 }, { unique: true }),
    collections.holidays.createIndex({ date: 1 }),
    // One open correction per person per day: a second one, or two sent at once, cannot both be stored.
    collections.corrections.createIndex({ employeeId: 1, date: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } }),
    // The approvals inbox (oldest first), unfinished approvals, and a person's own requests (newest first).
    collections.corrections.createIndex({ status: 1, submittedAt: 1 }),
    collections.corrections.createIndex({ employeeId: 1, submittedAt: -1 }),
    // What is showing now, and the list for those who manage them (newest first).
    collections.announcements.createIndex({ startsAt: -1, _id: -1 }),
    collections.announcements.createIndex({ expiresAt: 1 }),
    // Who has read an announcement; what a person has read is found by id.
    collections.announcementReads.createIndex({ announcementId: 1 }),
    collections.announcementReads.createIndex({ employeeId: 1 }),
    // A person's days in order (their calendar, their open day), and everyone's on one date (the daily view).
    collections.attendanceDays.createIndex({ employeeId: 1, date: 1 }),
    collections.attendanceDays.createIndex({ date: 1 }),
    // MongoDB removes expired sessions by itself.
    collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.sessions.createIndex({ employeeId: 1 }),
    // The audit log is read newest first, a page at a time: whole, about one person, by one person, or one kind of action.
    // Each index ends the way the page is ordered, so a page is read from it and the rest of the log is not touched.
    collections.audit.createIndex({ at: -1, _id: -1 }),
    collections.audit.createIndex({ employeeId: 1, at: -1, _id: -1 }),
    collections.audit.createIndex({ 'actor.id': 1, at: -1, _id: -1 }),
    collections.audit.createIndex({ action: 1, at: -1, _id: -1 }),
  ]);
  return collections;
}

export function db(): Collections {
  if (!collections) throw new Error('Database is not connected yet.');
  return collections;
}

/** Whether MongoDB answers right now. Used by the health check. */
export async function pingDatabase(): Promise<boolean> {
  if (!client) return false;
  try {
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function disconnect() {
  await client?.close();
  client = null;
  collections = null;
}

/** Drops this app's database. Used by the seed script's --reset and by the tests. */
export async function dropDatabase(dbName: string) {
  if (!client) throw new Error('Database is not connected yet.');
  await client.db(dbName).dropDatabase();
}

export const isDuplicateKey = (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;

export const toDoc = <T extends { id: string }>({ id, ...rest }: T) => ({ _id: id, ...rest }) as Doc<T>;
export const fromDoc = <T extends { id: string }>({ _id, ...rest }: Doc<T>) => ({ id: _id, ...rest }) as unknown as T;
