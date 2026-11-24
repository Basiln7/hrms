/*
 * The shapes that travel between the web app and the API. Both sides import these, so a
 * change to a response is a compile error on the side that has not caught up.
 */
import type { Announcement, AnnouncementState, Importance } from './announcements';
import type { AttendanceBreak, DayResult, HolidayType, PeriodSummary } from './attendance';
import type { CompanySettings } from './company';
import type { CorrectionRequest, CorrectionType } from './corrections';
import type { LocalDate, LocalDateTime, LocalMonth } from './dates';
import type { Holiday, HolidayCalendar } from './holidays';
import type { AccountEntry, LeaveApprover, LeavePolicy, LeaveRequest, LeaveTone, LeaveTouched, LeaveType, PolicyEntry, TypeBalance } from './leave';
import type { Employee, EmployeeStatus } from './org';
import type { LateCount, OverviewCounts, OverviewFilter } from './reports';
import type { PermissionId, Role } from './roles';
import type { DayHours, Schedule, ScheduleAssignment, ScheduleRules } from './schedules';

/** Every failed request answers with this. `fields` carries per-field messages for forms. */
export interface ErrorPayload {
  error: string;
  fields?: Record<string, string>;
  /** A machine-readable reason, where the web app must react to it (e.g. "password_change_required"). */
  code?: string;
  /** More about the refusal, for the few cases the web app shows it (what confirming would change). */
  details?: unknown;
}

/** Public facts the sign-in screen needs before anyone is signed in. */
export interface MetaPayload {
  /** Nobody exists yet: the first-run setup has to create the company and its Admin. */
  setupNeeded: boolean;
  /** Setup asks for the code from the server's settings. */
  setupCodeRequired: boolean;
  /** False when setup is needed but the server has no setup code, so it cannot be done from the browser. */
  setupAvailable: boolean;
}

export interface SetupInput {
  companyName: string;
  timeZone: string;
  name: string;
  email: string;
  password: string;
  setupCode?: string;
}

/** The signed-in person's own record, with the names their record points at. */
export interface SelfEmployee extends Employee {
  departmentName: string | null;
  managerName: string | null;
}

/** Everything the app needs to draw itself after sign-in. */
export interface MePayload {
  employee: SelfEmployee;
  permissions: PermissionId[];
  company: CompanySettings;
  /** The name of the work schedule they are on today, or null when they have none yet. */
  scheduleName: string | null;
  /** The server's clock, as an ISO moment. The only clock the app trusts. */
  serverNow: string;
  /** Requests waiting for this person to decide. 0 for someone who decides none. */
  approvalsWaiting: number;
  /** Announcements showing for them that they have still to read. */
  unreadAnnouncements: number;
}

/** A person in a list, with the names their record points at. */
export interface EmployeeRow extends Employee {
  departmentName: string | null;
  managerName: string | null;
  /** The schedule in force today, or null when they have none yet. */
  scheduleName: string | null;
  /** Their day today as it reads now, in their own time zone. Sent with a manager's team, not with every list. */
  today?: { day: DayResult; timeZone: string };
}

/** A person in brief, for forms that choose people. */
export interface PersonOption {
  id: string;
  code: string;
  name: string;
  role: Role;
  departmentId: string | null;
  departmentName: string | null;
  scheduleName: string | null;
  /** The holiday calendar they are on today, or null when they are on none. */
  calendarName: string | null;
}

/** One page of a list. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EmployeeFilters {
  search?: string;
  departmentId?: string;
  managerId?: string;
  role?: Role;
  status?: EmployeeStatus;
  page?: number;
}

/** What HR fills in to add someone. The server makes their code and their temporary password. */
export interface EmployeeInput {
  name: string;
  email: string;
  phone: string;
  role: Role;
  departmentId: string | null;
  designation: string;
  managerId: string | null;
  joinDate: LocalDate | null;
}

/** Adding someone can give them their first schedule in the same step. */
export interface NewEmployeeInput extends EmployeeInput {
  schedule: { scheduleId: string; effectiveFrom: LocalDate } | null;
}

/** The answer to adding someone or resetting their password. The temporary password is shown this once and kept nowhere readable. */
export interface TemporaryPasswordPayload {
  employee: Employee;
  temporaryPassword: string;
}

/** A person's schedule: what applies today, what is planned, and everything that ever applied. */
export interface EmployeeSchedulePayload {
  /** Today's date for this person: in the zone of the rules they work under, or the company's. */
  today: LocalDate;
  current: ScheduleAssignment | null;
  /** Assignments that have not started yet, soonest first. They can still be cancelled. */
  planned: ScheduleAssignment[];
  /** Every assignment, newest first. */
  history: ScheduleAssignment[];
  /** The names of the holiday calendars those assignments point at, by id. */
  calendarNames: Record<string, string>;
}

/** A standard schedule in the list, with how many people are on it today. */
export interface ScheduleRow extends Schedule {
  peopleCount: number;
}

export interface SchedulePerson {
  id: string;
  code: string;
  name: string;
  departmentName: string | null;
  status: EmployeeStatus;
  /** Since when they have been on it. */
  effectiveFrom: LocalDate;
}

export interface ScheduleDetailPayload extends Schedule {
  /** The people working under a copy of this schedule today. */
  people: SchedulePerson[];
}

/** Give one or many people a schedule from a date: a standard one, or rules made for them. */
export interface AssignmentInput {
  employeeIds: string[];
  scheduleId: string | null;
  rules: ScheduleRules | null;
  effectiveFrom: LocalDate;
  note: string;
  /**
   * The holiday calendar that goes with it, or null for none. Left out, each person keeps the
   * calendar they are on at that date, and someone getting their first schedule gets the
   * company default.
   */
  holidayCalendarId?: string | null;
}

/** What happened to each person in an assignment. Nobody is skipped silently. */
export interface AssignmentResult {
  assigned: { employeeId: string; name: string }[];
  skipped: { employeeId: string; name: string; reason: string }[];
  /** Leave requests of those people from the start date on: their days were counted with the schedule or calendar as it was. */
  leave?: LeaveTouched[];
}

export interface DepartmentRow {
  id: string;
  name: string;
  /** People in it who are not deactivated. */
  peopleCount: number;
}

/** One thing that happened to a day. The list is only ever added to: the first entries are the original punches. */
export interface AttendanceHistoryEntry {
  at: string;
  /** Who did it: the employee themself for a punch, HR or an approver for a correction. */
  by: string;
  byName: string;
  kind: 'check_in' | 'check_out' | 'break_start' | 'break_end' | 'corrected' | 'overridden' | 'excused' | 'note';
  before?: unknown;
  after?: unknown;
  requestId?: string;
  reason?: string;
}

/** The facts recorded for one person's one day, with everything that ever happened to it. */
export interface AttendanceRecord {
  employeeId: string;
  date: LocalDate;
  checkInAt: string | null;
  checkOutAt: string | null;
  breaks: AttendanceBreak[];
  override: 'present' | 'half_day' | null;
  lateExcused: boolean;
  /** HR's note on the day, shown to the person and their managers. */
  note: { text: string; byName: string; at: string } | null;
  history: AttendanceHistoryEntry[];
  /** Goes up with every change, so a decision can name the state it was made on. */
  version: number;
}

/** What the home page needs to draw today's attendance and its buttons. */
export interface TodayPayload {
  /** The server's clock: the only one the timer may use. */
  serverNow: string;
  /** Today's date for this person, in the zone of their schedule. */
  today: LocalDate;
  timeZone: string;
  /** The rules they work under today, or null when they have no schedule. */
  rules: ScheduleRules | null;
  /** The day the buttons act on: the one still open, or the one a check-in would belong to, or today. */
  day: DayResult;
  /** The rules that day is judged by: the ones it was punched under, when it has a punch. */
  dayRules: ScheduleRules | null;
  /** The hours that day asks for, when it is a working day. */
  hours: DayHours | null;
  /** The breaks recorded on that day. With the two above, all the live timer needs. */
  breaks: AttendanceBreak[];
  /** The open day began on an earlier date: say so, instead of offering one unlabelled button. */
  openFromEarlier: boolean;
  can: { checkIn: boolean; checkOut: boolean; startBreak: boolean; endBreak: boolean };
  /** Why check-in is not offered, when it is not and nothing is open. */
  checkInBlocked: string | null;
}

/** How many days back the home page lists under "Recent days". */
export const RECENT_DAYS = 7;

/** Everything the employee's home page shows about their attendance, in one answer. */
export interface MyDashboardPayload {
  today: TodayPayload;
  /** The calendar month today falls in, from its first day up to today, added up by the engine. */
  month: { from: LocalDate; to: LocalDate; summary: PeriodSummary };
  /** The days before the one in `today`, newest first: those of the last `RECENT_DAYS` that apply to the person. */
  recent: DayResult[];
  /** Their holiday calendar by name (null when they are on none) and the next few holidays on it. */
  holidays: { calendarName: string | null; upcoming: MyHoliday[] };
  /** Their own correction requests that are still waiting for a decision. */
  corrections: CorrectionRequest[];
  /** The first few announcements showing for them, and how many there are and are unread in all. */
  announcements: { items: AnnouncementView[]; total: number; unread: number };
  /** Their leave: what is left of each kind this leave year, their requests still waiting, and approved leave that is not over yet. */
  leave: { yearLabel: string; hasPolicy: boolean; balances: LeaveBalanceRow[]; waiting: LeaveRow[]; upcoming: LeaveRow[] };
}

/** How many holidays the home page lists under "Upcoming holidays". */
export const UPCOMING_HOLIDAYS = 3;

/** A holiday as an employee sees it: without who entered it or when. */
export type MyHoliday = Pick<Holiday, 'date' | 'name' | 'type' | 'description'>;

/** One person's holidays in a year, each from the calendar they were on at that date. */
export interface MyHolidaysPayload {
  year: number;
  /** Today's date for this person. */
  today: LocalDate;
  /** The calendar they are on now, or will be on when their schedule starts. Null when they are on none. */
  calendarName: string | null;
  holidays: MyHoliday[];
  /** Their next holiday from today on, whichever year it falls in. */
  next: MyHoliday | null;
}

/** One person's month: every day as the engine reads it now, and the month added up. */
export interface AttendanceCalendarPayload {
  employee: { id: string; code: string; name: string };
  month: LocalMonth;
  /** Today's date for this person, in the zone of their schedule. */
  today: LocalDate;
  timeZone: string;
  /** Every date of the month, in order. */
  days: DayResult[];
  summary: PeriodSummary;
}

/** The answer when a change to a holiday would alter days that have already begun and was not confirmed. */
export const CONFIRM_PAST = 'confirm_past';

/** A holiday calendar in the list. */
export interface CalendarRow extends HolidayCalendar {
  /** Preselected for people getting their first schedule. */
  isDefault: boolean;
  /** Holidays dated in the year asked for. */
  holidayCount: number;
  /** People on it today. */
  peopleCount: number;
}

export interface CalendarListPayload {
  year: number;
  calendars: CalendarRow[];
  /** People with a schedule in force today who are on no holiday calendar. */
  withoutCalendar: number;
}

export interface CalendarDetailPayload extends CalendarRow {
  year: number;
  /** Today's date in the company's time zone. */
  today: LocalDate;
  holidays: Holiday[];
  /** The years this calendar has holidays in. */
  years: number[];
  /** The people on it today. */
  people: SchedulePerson[];
}

/** Put one or many people on a holiday calendar (or on none) from a date. */
export interface CalendarAssignInput {
  calendarId: string | null;
  employeeIds: string[];
  effectiveFrom: LocalDate;
}

/** What copying a year's holidays into the next did, holiday by holiday. */
export interface CopyYearResult {
  toYear: number;
  copied: Holiday[];
  skipped: { date: LocalDate; name: string; reason: string }[];
}

/** One day in full: how it reads, what was recorded, and its history. */
export interface DayDetailPayload {
  day: DayResult;
  record: AttendanceRecord | null;
  /** The schedule the day is judged by, or null when none applies. */
  scheduleName: string | null;
  timeZone: string | null;
  /** Goes up with every change to the day; 0 when nothing is recorded. A correction names the version it was made against. */
  version: number;
  /** A correction request for this day that is waiting for a decision. */
  pending: CorrectionRequest | null;
  /**
   * For the person whose day it is: the kinds of correction they could ask for, or why they
   * cannot ask for any. Null when the caller is looking at someone else's day.
   */
  requestable: { types: CorrectionType[]; blocked: string | null } | null;
  /** Whether the caller may correct this day directly, or leave a note on it (HR, and never on their own record). */
  editable: boolean;
}

/** A correction request in a list, with whose it is. */
export interface CorrectionRow extends CorrectionRequest {
  employeeName: string;
  employeeCode: string;
  /** The zone its times are shown in. */
  timeZone: string;
}

/** A request waiting for a decision, with what the approver needs to decide it. */
export interface CorrectionInboxItem extends CorrectionRow {
  /** The day as it reads now. */
  now: DayResult;
  /** How it would read if the request were approved now. Null when the request no longer fits the day. */
  after: DayResult | null;
  /** Why it no longer fits, when it does not: it can only be rejected. */
  problem: string | null;
  /** The version of the day shown here. Approving names it, so a day that changed in between is not corrected blind. */
  dayVersion: number;
}

export type CorrectionView = 'mine' | 'inbox' | 'decided';

export interface CorrectionListPayload {
  view: CorrectionView;
  items: (CorrectionRow | CorrectionInboxItem)[];
  total: number;
  page: number;
  pageSize: number;
}

/** A leave policy in the list. */
export interface LeavePolicyRow extends LeavePolicy {
  /** Given to people as they are added. */
  isDefault: boolean;
  /** People on it who are not deactivated. */
  peopleCount: number;
}

/** Everything the leave setup page needs. */
export interface LeaveSetupPayload {
  types: LeaveType[];
  policies: LeavePolicyRow[];
  /** People who are not deactivated and are on no leave policy. */
  withoutPolicy: number;
  /** The leave year today falls in, in words. */
  yearLabel: string;
}

/** One kind of leave in someone's account: the rules of their policy for it, and the account added up. */
export interface LeaveBalanceRow {
  type: LeaveType;
  /** Null when their policy no longer includes it: what is left stays, and no more can be asked for. */
  entry: PolicyEntry | null;
  balance: TypeBalance;
}

/** One person's leave account for one leave year, read now. */
export interface LeaveBalancesPayload {
  employee: { id: string; code: string; name: string };
  leaveYear: number;
  yearLabel: string;
  range: { from: LocalDate; to: LocalDate };
  /** The leave year today falls in for them. */
  currentYear: number;
  /** The leave years that can be looked at, oldest first. */
  years: { year: number; label: string }[];
  /** Today's date for this person. */
  today: LocalDate;
  policy: { id: string; name: string; approver: LeaveApprover } | null;
  rows: LeaveBalanceRow[];
  /** Everything added to or taken off the account, oldest first. */
  entries: (AccountEntry & { typeName: string })[];
  /** Whether the caller may adjust this account (HR, and never their own). */
  canAdjust: boolean;
}

/** HR adds days to someone's account or takes days off it, with the reason. */
export interface LeaveAdjustmentInput {
  employeeId: string;
  leaveYear: number;
  leaveTypeId: string;
  /** Positive adds, negative removes. In whole or half days, never zero. */
  days: number;
  note: string;
}

/** Put one or many people on a leave policy, or on none. */
export interface PolicyAssignInput {
  policyId: string | null;
  employeeIds: string[];
}

/** A leave request in a list, with whose it is and what kind of leave it is. */
export interface LeaveRow extends LeaveRequest {
  employeeName: string;
  employeeCode: string;
  typeName: string;
  typeCode: string;
  typeTone: LeaveTone;
  paid: boolean;
  /** What the caller may do about it now: nothing, cancel it, or cancel it with an HR power (which needs a reason). */
  cancel: 'no' | 'yes' | 'with_reason';
}

/** A request waiting for a decision, with what it does to the balance. */
export interface LeaveInboxItem extends LeaveRow {
  /** That kind of leave in the person's account now. The days of this request are among the held ones. */
  balance: TypeBalance;
  /** Whether that kind needs a balance at all (unpaid leave, or a policy that lets it go below zero, does not). */
  unlimited: boolean;
}

export type LeaveView = 'mine' | 'inbox' | 'decided' | 'person';

export interface LeaveListPayload {
  view: LeaveView;
  items: (LeaveRow | LeaveInboxItem)[];
  total: number;
  page: number;
  pageSize: number;
}

/** What a request would use and leave, worked out by the API before anything is sent. */
export interface LeavePreviewPayload {
  /** What is wrong with it as it stands, by field. Empty when it could be sent (the reason is not looked at here). */
  errors: Record<string, string>;
  yearLabel: string | null;
  days: number;
  /** The dates that are counted. */
  charged: LocalDate[];
  /** The dates in the range that cost nothing, and why. */
  notCounted: { date: LocalDate; why: 'weekly_off' | 'holiday' | 'not_applicable'; name?: string }[];
  /** What is available now and what would be after. Null until the kind of leave is known. */
  balance: { available: number; after: number; unlimited: boolean } | null;
}

/** A person as the overview, the records and the reports name them. */
export interface ReportPerson {
  id: string;
  code: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  status: EmployeeStatus;
  /** Someone reports to them: they can be chosen as "manager" to narrow a report to their team. */
  hasReports: boolean;
}

/** One person on the overview: who they are, and their day as the engine reads it now. */
export interface OverviewRow extends ReportPerson {
  /** The zone the day's times are shown in. */
  timeZone: string;
  scheduleName: string | null;
  day: DayResult;
}

/** One day for everyone the caller may see. */
export interface OverviewPayload {
  date: LocalDate;
  /** Today's date in the company's time zone. */
  today: LocalDate;
  /** Whose day this is: everyone, or the people who report to the caller. */
  scope: 'all' | 'team';
  /** How many people are in each group. The groups add up to `all`; "checked in" and "late" cut across them. */
  counts: OverviewCounts;
  /** Which number the list below is the list behind. */
  filter: OverviewFilter;
  people: Page<OverviewRow>;
  /** Requests waiting for the caller to decide. */
  waiting: { leave: number; corrections: number };
  /** The next holidays, from this date on, on the calendars the people in view are on. */
  holidays: { date: LocalDate; name: string; type: HolidayType; calendarName: string }[];
}

/** One person's one day in the records. */
export interface RecordRow extends ReportPerson {
  timeZone: string;
  day: DayResult;
}

/** How often someone was late in a stretch of days. */
export interface LateRow extends ReportPerson, LateCount {}

export interface RecordsPayload {
  from: LocalDate;
  to: LocalDate;
  today: LocalDate;
  /** One page of the days that match, newest first. */
  items: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Everyone in view who was late at least once in the stretch, most often first. */
  late: LateRow[];
}

export interface MonthlyRow extends ReportPerson {
  summary: PeriodSummary;
}

/** A month, one row per person, as the calendar adds it up for each of them now. */
export interface MonthlyReportPayload {
  month: LocalMonth;
  from: LocalDate;
  to: LocalDate;
  today: LocalDate;
  rows: MonthlyRow[];
  totals: PeriodSummary;
  /** People in view for whom no day of the month counts, and who are therefore not rows. */
  notCounted: number;
}

/** One person's days between two dates. */
export interface EmployeeReportPayload {
  employee: ReportPerson;
  from: LocalDate;
  to: LocalDate;
  today: LocalDate;
  timeZone: string;
  days: DayResult[];
  summary: PeriodSummary;
}

/** How many announcements the home page shows before pointing at the rest. */
export const HOME_ANNOUNCEMENTS = 3;

/** An announcement as the people it is for see it: without who it was sent to. */
export interface AnnouncementView {
  id: string;
  title: string;
  /** Plain text, to be shown as text. */
  body: string;
  importance: Importance;
  pinned: boolean;
  startsAt: string;
  expiresAt: string | null;
  postedByName: string;
  /** The reader has not opened it since its text last changed. */
  unread: boolean;
}

/** What is showing for the signed-in person now, pinned and important first. */
export interface AnnouncementFeedPayload {
  items: AnnouncementView[];
  unread: number;
}

/** An announcement as those who manage them see it. */
export interface AnnouncementRow extends Announcement {
  state: AnnouncementState;
  /** Who it is for, in words: "Everyone", "Sales and Support", "Managers and HR". */
  audienceWords: string;
  /** How many people who are not deactivated it is for today. */
  audienceSize: number;
  /** How many of them have opened it as it now stands. */
  readCount: number;
  /** Its two times on the wall clock of the company's zone, as the form holds them. */
  startsAtLocal: LocalDateTime;
  expiresAtLocal: LocalDateTime | null;
}

export interface AnnouncementManagePayload {
  items: AnnouncementRow[];
  total: number;
  page: number;
  pageSize: number;
  /** The company's time zone: the form's two times are on its wall clock. */
  timeZone: string;
}

/** The answer when an approval names a version of the day that is no longer the current one. */
export const DAY_CHANGED = 'day_changed';

export const PASSWORD_CHANGE_REQUIRED = 'password_change_required';
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
