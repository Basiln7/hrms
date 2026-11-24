import {
  addDays,
  addSummaries,
  countOverview,
  daysBetween,
  employeeRows,
  evaluateDay,
  inOverview,
  inRecords,
  lateCount,
  localDateOf,
  monthInWords,
  monthlyRows,
  monthOf,
  monthRange,
  recordRows,
  reportsOf,
  summarize,
  type CsvCell,
  type DayResult,
  type EmployeeReportPayload,
  type Holiday,
  type LateRow,
  type LocalDate,
  type LocalMonth,
  type MonthlyReportPayload,
  type MonthlyRow,
  type OrgNode,
  type OverviewFilter,
  type OverviewPayload,
  type OverviewRow,
  type RecordFilter,
  type RecordRow,
  type RecordsPayload,
  type ReportPerson,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, fromDoc, type Account, type AttendanceDayDoc, type Doc } from '../db';
import type { RequestContext } from '../http/context';
import { forbidden, notFound, unprocessable } from '../http/errors';
import { assertInScope, loadOrg } from './access';
import { contextsFor, daysIn, inputFor, contextFor, type PersonContext } from './attendance';
import { recordAudit } from './audit';
import { calendarNames } from './calendarStore';
import { approvalsWaitingFor } from './corrections';
import { leaveWaitingFor } from './leave';
import { loadCompany } from './settings';

/*
 * The overview of a day, attendance records and reports.
 *
 * Two things hold for all of them:
 *
 * - WHO. The people a caller gets are worked out here on every call, from their role and
 *   today's organisation: everyone for HR and Admin, the people who report to them (directly
 *   or through their reports) for a Manager. A filter can only narrow that. Naming someone
 *   outside it answers "not found", as for someone who does not exist.
 * - WHAT. Every day is read by the engine, at this moment, from the stored facts: the same
 *   function and the same facts as the calendar. Nothing here keeps a count of its own.
 *
 * Many people are read with a fixed handful of queries, whatever their number (see
 * `contextsFor`), and the engine then runs in memory.
 */

export const OVERVIEW_PAGE = 50;
export const RECORDS_PAGE = 50;
/** The longest stretch records are read for at once. */
export const RECORDS_MAX_DAYS = 92;
/** The longest stretch one person's report covers. */
export const EMPLOYEE_REPORT_MAX_DAYS = 366;

export interface PeopleFilter {
  departmentId?: string;
  managerId?: string;
  employeeId?: string;
}

interface Reach {
  /** Everyone, or the people who report to the caller. */
  scope: 'all' | 'team';
  org: OrgNode[];
  people: Account[];
  departments: Map<string, string>;
}

/**
 * The people a report covers for this caller, narrowed by the filters. Someone deactivated is
 * left out unless `withInactive`: a monthly report still has to show a person who left
 * during the month.
 */
async function reachOf(ctx: RequestContext, filter: PeopleFilter, withInactive: boolean): Promise<Reach> {
  const org = await loadOrg();
  const all = ctx.can('employees.viewAll');
  const mine = new Set(all ? org.map((p) => p.id) : reportsOf(org, ctx.employee.id));
  let ids = [...mine];

  if (filter.managerId) {
    // A manager may look at their own team, or at the team of someone in it.
    if (!(mine.has(filter.managerId) || filter.managerId === ctx.employee.id)) throw notFound('That person does not exist.');
    const under = new Set(reportsOf(org, filter.managerId));
    ids = ids.filter((id) => under.has(id));
  }
  if (filter.employeeId) {
    if (!mine.has(filter.employeeId)) throw notFound('That person does not exist.');
    ids = ids.filter((id) => id === filter.employeeId);
  }

  const [docs, departmentDocs] = await Promise.all([
    db()
      .employees.find({ _id: { $in: ids }, ...(filter.departmentId ? { departmentId: filter.departmentId } : {}), ...(withInactive ? {} : { status: { $ne: 'inactive' } }) })
      .sort({ name: 1, _id: 1 })
      .toArray(),
    db().departments.find({}, { projection: { name: 1 } }).toArray(),
  ]);
  return { scope: all ? 'all' : 'team', org, people: docs.map((doc) => fromDoc<Account>(doc)), departments: new Map(departmentDocs.map((d) => [d._id, d.name])) };
}

const personOf = (account: Account, reach: Pick<Reach, 'org' | 'departments'>): ReportPerson => ({
  id: account.id,
  code: account.code,
  name: account.name,
  departmentId: account.departmentId,
  departmentName: (account.departmentId && reach.departments.get(account.departmentId)) || null,
  status: account.status,
  hasReports: reach.org.some((p) => p.managerId === account.id),
});

/** The people the caller's reports cover, for the forms that choose one of them. */
export async function reportPeople(ctx: RequestContext): Promise<ReportPerson[]> {
  const reach = await reachOf(ctx, {}, true);
  return reach.people.map((account) => personOf(account, reach));
}

/** What is recorded for some people between two dates, by person and by date. */
async function recordsOf(ids: readonly string[], from: LocalDate, to: LocalDate): Promise<Map<string, Map<LocalDate, AttendanceDayDoc>>> {
  const byPerson = new Map<string, Map<LocalDate, AttendanceDayDoc>>();
  if (ids.length === 0) return byPerson;
  const docs = await db()
    .attendanceDays.find({ employeeId: { $in: [...ids] }, date: { $gte: from, $lte: to } })
    .toArray();
  for (const doc of docs) {
    const days = byPerson.get(doc.employeeId) ?? new Map<LocalDate, AttendanceDayDoc>();
    days.set(doc.date, doc);
    byPerson.set(doc.employeeId, days);
  }
  return byPerson;
}

interface PersonDays {
  account: Account;
  person: PersonContext;
  days: DayResult[];
}

/** Every day from one date to another, for many people, as the engine reads each now. */
async function readDays(people: readonly Account[], from: LocalDate, to: LocalDate, now: Date): Promise<PersonDays[]> {
  const ids = people.map((p) => p.id);
  const [contexts, records] = await Promise.all([contextsFor(people, now, { from, to }), recordsOf(ids, from, to)]);
  return people.map((account) => {
    const person = contexts.get(account.id)!;
    const mine = records.get(account.id);
    const days: DayResult[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) days.push(evaluateDay(date, now, person.ctx, inputFor(mine?.get(date) ?? null, person, date)));
    return { account, person, days };
  });
}

/**
 * The day someone is in: the given date, or the day before it when that date is today for
 * them, nothing is punched on it yet, and they are still at work on a shift that began the
 * day before (a night shift after midnight).
 */
function dayTheyAreIn(before: DayResult, on: DayResult, person: PersonContext, now: Date): DayResult {
  const stillOn = on.date === localDateOf(now, person.timeZone) && !on.checkInAt && (before.status === 'working' || before.status === 'on_break');
  return stillOn ? before : on;
}

/** Today for each of some people, in their own time zone, as the engine reads it now. For a manager's team list. */
export async function todayOfEach(people: readonly Account[]): Promise<Map<string, { day: DayResult; timeZone: string }>> {
  const now = clock.now();
  const company = localDateOf(now, (await loadCompany()).timeZone);
  // A day either side of the company's date: someone far east or west may already be in tomorrow, or still in yesterday.
  const from = addDays(company, -2);
  const found = new Map<string, { day: DayResult; timeZone: string }>();
  for (const { account, person, days } of await readDays(people, from, addDays(company, 1), now)) {
    const index = daysBetween(from, localDateOf(now, person.timeZone));
    const [before, on] = [days[index - 1], days[index]];
    if (before && on) found.set(account.id, { day: dayTheyAreIn(before, on, person, now), timeZone: person.ctx.rulesOn(on.date)?.timeZone ?? person.timeZone });
  }
  return found;
}

const matches = (text: string, search: string) => text.toLowerCase().includes(search);

/**
 * One day for everyone in view: how many people are in each group, and the people behind
 * whichever number is asked for. Each person's day is read in their own time zone.
 *
 * For today, someone who is still at work on a shift that began yesterday (a night shift
 * after midnight) is shown on that shift: it is the day they are in.
 */
export async function overview(ctx: RequestContext, asked: { date?: LocalDate; filter: OverviewFilter; search?: string; page: number } & PeopleFilter): Promise<OverviewPayload> {
  const now = clock.now();
  const [company, reach] = await Promise.all([loadCompany(), reachOf(ctx, asked, false)]);
  const today = localDateOf(now, company.timeZone);
  const date = asked.date ?? today;
  const read = await readDays(reach.people, addDays(date, -1), date, now);

  const rows: OverviewRow[] = read.map(({ account, person, days }) => {
    const [before, on] = days as [DayResult, DayResult];
    return { ...personOf(account, reach), timeZone: person.ctx.rulesOn(date)?.timeZone ?? person.timeZone, scheduleName: person.ctx.rulesOn(date)?.name ?? null, day: dayTheyAreIn(before, on, person, now) };
  });

  const search = asked.search?.trim().toLowerCase();
  const shown = rows.filter((row) => inOverview(row.day, asked.filter) && (!search || matches(row.name, search) || matches(row.code, search)));
  const calendarIds = [...new Set(read.map(({ person }) => person.calendarId).filter((id): id is string => id !== null))];
  const [corrections, leave, holidayDocs, names] = await Promise.all([
    approvalsWaitingFor(ctx.employee),
    leaveWaitingFor(ctx.employee, reach.org),
    calendarIds.length === 0
      ? Promise.resolve([] as Doc<Holiday>[])
      : db()
          .holidays.find({ calendarId: { $in: calendarIds }, date: { $gte: date } })
          .sort({ date: 1 })
          .limit(6)
          .toArray(),
    calendarNames(calendarIds),
  ]);

  return {
    date,
    today,
    scope: reach.scope,
    counts: countOverview(rows.map((row) => row.day)),
    filter: asked.filter,
    people: { items: shown.slice((asked.page - 1) * OVERVIEW_PAGE, asked.page * OVERVIEW_PAGE), total: shown.length, page: asked.page, pageSize: OVERVIEW_PAGE },
    waiting: { leave, corrections },
    holidays: holidayDocs.map((h) => ({ date: h.date, name: h.name, type: h.type, calendarName: names.get(h.calendarId) ?? 'A calendar' })),
  };
}

/** A stretch of dates that is in order and no longer than allowed, or a refusal beside its field. */
function soundRange(from: LocalDate, to: LocalDate, maxDays: number) {
  if (to < from) throw unprocessable('The last day cannot be before the first.', { to: 'The last day cannot be before the first.' });
  if (daysBetween(from, to) + 1 > maxDays) {
    const message = `Choose ${maxDays} days or fewer at a time.`;
    throw unprocessable(message, { to: message });
  }
}

interface RecordsAsk extends PeopleFilter, RecordFilter {
  from?: LocalDate;
  to?: LocalDate;
  page: number;
}

/** Everything the records list and its CSV are made of: the days that match, newest first, and who was late how often. */
async function readRecords(ctx: RequestContext, asked: RecordsAsk) {
  const now = clock.now();
  const [company, reach] = await Promise.all([loadCompany(), reachOf(ctx, asked, true)]);
  const today = localDateOf(now, company.timeZone);
  // With nothing asked for: this month so far.
  const to = asked.to ?? today;
  const from = asked.from ?? (asked.to ? monthRange(monthOf(to)).from : monthRange(monthOf(today)).from);
  soundRange(from, to, RECORDS_MAX_DAYS);

  const read = await readDays(reach.people, from, to, now);
  const rows: RecordRow[] = [];
  const late: LateRow[] = [];
  for (const { account, person, days } of read) {
    const who = personOf(account, reach);
    for (const day of days) if (inRecords(day, asked)) rows.push({ ...who, timeZone: person.ctx.rulesOn(day.date)?.timeZone ?? person.timeZone, day });
    const count = lateCount(days);
    if (count.entries > 0) late.push({ ...who, ...count });
  }
  rows.sort((a, b) => (a.day.date === b.day.date ? a.name.localeCompare(b.name) : a.day.date < b.day.date ? 1 : -1));
  late.sort((a, b) => b.entries - a.entries || b.minutes - a.minutes || a.name.localeCompare(b.name));
  return { from, to, today, rows, late };
}

/**
 * Everyone's days between two dates, narrowed by status and by mark, with how often each
 * person was late in that stretch.
 */
export async function records(ctx: RequestContext, asked: RecordsAsk): Promise<RecordsPayload> {
  const { from, to, today, rows, late } = await readRecords(ctx, asked);
  return { from, to, today, items: rows.slice((asked.page - 1) * RECORDS_PAGE, asked.page * RECORDS_PAGE), total: rows.length, page: asked.page, pageSize: RECORDS_PAGE, late };
}

export interface CsvFile {
  filename: string;
  rows: CsvCell[][];
}

/** The same records, all of them, as rows for a file. Written to the audit log: it is other people's attendance leaving the HRMS. */
export async function recordsCsv(ctx: RequestContext, asked: RecordsAsk): Promise<CsvFile> {
  const { from, to, rows } = await readRecords(ctx, asked);
  await recordAudit(ctx, { action: 'report.exported', targetType: 'report', summary: `Downloaded attendance records from ${from} to ${to}: ${rows.length} ${rows.length === 1 ? 'day' : 'days'}.`, after: { report: 'records', from, to, rows: rows.length, filter: { status: asked.status, flag: asked.flag, departmentId: asked.departmentId, managerId: asked.managerId, employeeId: asked.employeeId } } });
  return { filename: `attendance-records-${from}-to-${to}.csv`, rows: recordRows(rows) };
}

/**
 * One row per person for a month: the month as the calendar adds it up for each of them,
 * read now. People for whom no day of the month counts (no schedule yet, or not employed
 * then) are left out and counted.
 */
export async function monthlyReport(ctx: RequestContext, asked: { month?: LocalMonth } & PeopleFilter): Promise<MonthlyReportPayload> {
  const now = clock.now();
  const [company, reach] = await Promise.all([loadCompany(), reachOf(ctx, asked, true)]);
  const today = localDateOf(now, company.timeZone);
  const month = asked.month ?? monthOf(today);
  const { from, to } = monthRange(month);

  const rows: MonthlyRow[] = [];
  let notCounted = 0;
  for (const { account, days } of await readDays(reach.people, from, to, now)) {
    if (days.every((day) => day.kind === null)) notCounted += 1;
    else rows.push({ ...personOf(account, reach), summary: summarize(days) });
  }
  return { month, from, to, today, rows, totals: addSummaries(rows.map((row) => row.summary)), notCounted };
}

export async function monthlyCsv(ctx: RequestContext, asked: { month?: LocalMonth } & PeopleFilter): Promise<CsvFile> {
  const report = await monthlyReport(ctx, asked);
  await recordAudit(ctx, { action: 'report.exported', targetType: 'report', summary: `Downloaded the monthly summary for ${monthInWords(report.month)}: ${report.rows.length} ${report.rows.length === 1 ? 'person' : 'people'}.`, after: { report: 'monthly', month: report.month, rows: report.rows.length, filter: { departmentId: asked.departmentId, managerId: asked.managerId } } });
  return { filename: `monthly-summary-${report.month}.csv`, rows: monthlyRows(report.rows, report.totals) };
}

/** Reads one person's report, if the caller may: their own, or (with the permission to see reports) someone they may see. */
async function readEmployeeReport(ctx: RequestContext, employeeId: string, asked: { from?: LocalDate; to?: LocalDate }) {
  const own = employeeId === ctx.employee.id;
  // Without the permission, anyone else is answered exactly as someone who does not exist.
  if (!own && !ctx.can('reports.view')) throw notFound('That person does not exist.');
  await assertInScope(ctx, employeeId);
  const doc = own ? null : await db().employees.findOne({ _id: employeeId });
  const account = own ? ctx.employee : doc ? fromDoc<Account>(doc) : null;
  if (!account) throw notFound('That person does not exist.');

  const now = clock.now();
  const person = await contextFor(account, now);
  const today = localDateOf(now, person.timeZone);
  const to = asked.to ?? today;
  const from = asked.from ?? monthRange(monthOf(to)).from;
  soundRange(from, to, EMPLOYEE_REPORT_MAX_DAYS);
  const [days, departments, org] = await Promise.all([daysIn(employeeId, person, from, to, now), db().departments.find({}, { projection: { name: 1 } }).toArray(), own ? Promise.resolve<OrgNode[]>([]) : loadOrg()]);
  return { own, account, person, from, to, today, days, who: personOf(account, { org, departments: new Map(departments.map((d) => [d._id, d.name])) }) };
}

/** One person's days between two dates, and the stretch added up. */
export async function employeeReport(ctx: RequestContext, employeeId: string, asked: { from?: LocalDate; to?: LocalDate }): Promise<EmployeeReportPayload> {
  const { who, person, from, to, today, days } = await readEmployeeReport(ctx, employeeId, asked);
  return { employee: who, from, to, today, timeZone: person.timeZone, days, summary: summarize(days) };
}

/** The same as a file. One's own needs no permission; anyone else's needs the permission to export. */
export async function employeeCsv(ctx: RequestContext, employeeId: string, asked: { from?: LocalDate; to?: LocalDate }): Promise<CsvFile> {
  if (employeeId !== ctx.employee.id && !ctx.can('reports.export')) throw ctx.can('reports.view') ? forbidden('Your role cannot download reports.') : notFound('That person does not exist.');
  const { own, account, person, from, to, days } = await readEmployeeReport(ctx, employeeId, asked);
  if (!own) await recordAudit(ctx, { action: 'report.exported', targetType: 'report', employeeId, summary: `Downloaded ${account.name}'s attendance from ${from} to ${to}.`, after: { report: 'employee', from, to } });
  // Days that do not count for the person at all are not rows of their report.
  return { filename: `attendance-${account.code}-${from}-to-${to}.csv`, rows: employeeRows(days.filter((day) => day.kind !== null), person.timeZone) };
}
