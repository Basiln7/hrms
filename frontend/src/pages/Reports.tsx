import { useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, UserRound } from 'lucide-react';
import { hoursOf, isLocalDate, isLocalMonth, monthInWords, type EmployeeReportPayload, type MonthlyReportPayload, type PeriodSummary } from '@delta-hrms/shared';
import { DayRows, SummaryTiles } from '../components/attendance';
import { DepartmentSelect, DownloadButton, ManagerSelect, PersonCell, PersonSelect, useReportPeople } from '../components/reports';
import { LoadError, SkeletonLines } from '../components/states';
import { Empty, TabPanel, Tabs } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { dayCount, dayDate } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';

type Kind = 'monthly' | 'person';

/** The columns of the monthly summary, in the order of the file. Every number is the calendar's own. */
const COLUMNS: { heading: string; hint: string; of: (s: PeriodSummary) => number }[] = [
  { heading: 'Days', hint: 'Working days counted so far', of: (s) => s.workingDays },
  { heading: 'Present', hint: 'Full days', of: (s) => s.presentDays },
  { heading: 'Half', hint: 'Half-days', of: (s) => s.halfDays },
  { heading: 'Leave', hint: 'Leave, paid and unpaid', of: (s) => s.leaveDays },
  { heading: 'Absent', hint: 'Absent, with the missing half of each half-day', of: (s) => s.absentDays },
  { heading: 'Unresolved', hint: 'A check-in with no check-out, not yet corrected', of: (s) => s.unresolvedDays },
  { heading: 'Late', hint: 'Late entries', of: (s) => s.lateEntries },
  { heading: 'Early', hint: 'Early departures', of: (s) => s.earlyDepartures },
  { heading: 'Hours', hint: 'Hours worked on days that were checked out of', of: (s) => hoursOf(s.workedMinutes) },
];

function Monthly({ set, params }: { set: (name: string, value: string) => void; params: URLSearchParams }) {
  const { can } = useAuth();
  const people = useReportPeople();
  const asked = { month: isLocalMonth(params.get('month')) ? params.get('month')! : '', departmentId: params.get('departmentId') ?? '', managerId: params.get('managerId') ?? '' };
  const { data, error, reload } = useLoad<MonthlyReportPayload>(`/reports/monthly${queryOf(asked)}`);

  return (
    <>
      <div className="toolbar" role="group" aria-label="Month and people">
        <label className="dated">
          <span>Month</span>
          <input className="input" type="month" value={asked.month || data?.month || ''} onChange={(e) => set('month', e.target.value)} />
        </label>
        <DepartmentSelect value={asked.departmentId} onChange={(id) => set('departmentId', id)} />
        <ManagerSelect people={people.data} value={asked.managerId} onChange={(id) => set('managerId', id)} />
        {can('reports.export') && data && data.rows.length > 0 && (
          <DownloadButton small path={`/reports/monthly${queryOf({ ...asked, month: data.month, format: 'csv' })}`}>
            Download CSV
          </DownloadButton>
        )}
      </div>

      <section className="card" aria-label="Monthly summary">
        {error && !data ? (
          <LoadError message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonLines lines={8} />
        ) : data.rows.length === 0 ? (
          <Empty icon={<FileSpreadsheet size={30} />} title={`Nothing is counted in ${monthInWords(data.month)}`} body="Attendance counts from a person’s first day on a work schedule, and only while they are employed. Nobody in view has such a day in this month." />
        ) : (
          <>
            <div className="card-head">
              <div>
                <h2 className="card-title">{monthInWords(data.month)}</h2>
                <p className="card-sub">
                  {data.rows.length} {data.rows.length === 1 ? 'person' : 'people'}, each as their calendar adds the month up now
                  {data.month >= data.today.slice(0, 7) ? '. The month is not over: days still to come are not counted yet' : ''}.
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Department</th>
                    {COLUMNS.map((column) => (
                      <th scope="col" key={column.heading} className="cell-end" title={column.hint}>
                        {column.heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <PersonCell person={row} />
                      </td>
                      <td className={row.departmentName ? undefined : 'cell-none'}>{row.departmentName ?? 'None'}</td>
                      {COLUMNS.map((column) => (
                        <td key={column.heading} className="cell-end num">
                          {dayCount(column.of(row.summary))}
                          {column.heading === 'Leave' && row.summary.unpaidLeaveDays > 0 && <span className="cell-sub">{dayCount(row.summary.unpaidLeaveDays)} unpaid</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2}>
                      Total
                    </th>
                    {COLUMNS.map((column) => (
                      <td key={column.heading} className="cell-end num">
                        {dayCount(column.of(data.totals))}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
            {data.notCounted > 0 && (
              <p className="tiles-foot">
                {data.notCounted} {data.notCounted === 1 ? 'person in view is' : 'people in view are'} not listed: no day of this month counts for them (no work schedule then, or not employed then).
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}

function OnePerson({ set, params }: { set: (name: string, value: string) => void; params: URLSearchParams }) {
  const { can } = useAuth();
  const people = useReportPeople();
  const date = (name: string) => (isLocalDate(params.get(name)) ? params.get(name)! : '');
  const asked = { employeeId: params.get('employeeId') ?? '', from: date('from'), to: date('to') };
  const range = queryOf({ from: asked.from, to: asked.to });
  const { data, error, reload } = useLoad<EmployeeReportPayload>(asked.employeeId ? `/reports/employee/${asked.employeeId}${range}` : null);
  // Up to today, and only the days that count for them: the rest say nothing.
  const listed = data ? data.days.filter((day) => day.date <= data.today && day.status !== 'not_applicable').reverse() : [];

  return (
    <>
      <div className="toolbar" role="group" aria-label="Person and dates">
        <PersonSelect people={people.data} value={asked.employeeId} onChange={(id) => set('employeeId', id)} none="Choose a person…" />
        <label className="dated">
          <span>From</span>
          <input className="input" type="date" value={asked.from || data?.from || ''} max={asked.to || data?.to} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="dated">
          <span>To</span>
          <input className="input" type="date" value={asked.to || data?.to || ''} min={asked.from || data?.from} onChange={(e) => set('to', e.target.value)} />
        </label>
        {can('reports.export') && data && (
          <DownloadButton small path={`/reports/employee/${data.employee.id}${queryOf({ from: data.from, to: data.to, format: 'csv' })}`}>
            Download CSV
          </DownloadButton>
        )}
      </div>

      <section className="card" aria-label="One person’s days">
        {!asked.employeeId ? (
          <Empty icon={<UserRound size={30} />} title="Choose a person" body="Their days between two dates, each as it reads now, and the stretch added up. With no dates it is this month so far." />
        ) : error && !data ? (
          <LoadError message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonLines lines={8} />
        ) : (
          <>
            <div className="card-head">
              <div>
                <h2 className="card-title">{data.employee.name}</h2>
                <p className="card-sub">
                  {data.employee.code}
                  {data.employee.departmentName ? ` · ${data.employee.departmentName}` : ''} · {dayDate(data.from)} to {dayDate(data.to)} · {data.timeZone}
                </p>
              </div>
            </div>
            <SummaryTiles summary={data.summary} />
            <h3 className="subhead">Day by day</h3>
            {listed.length === 0 ? <p className="muted">No day in this stretch counts for them.</p> : <DayRows days={listed} timeZone={data.timeZone} />}
          </>
        )}
      </section>
    </>
  );
}

/**
 * Reports for those who may see them: a month with one row per person, and one person's
 * days between two dates. Both are read now, by the same function as the calendar, and both
 * can be downloaded as a file with the same rows.
 */
export default function Reports() {
  const [params, setParams] = useSearchParams();
  const kind: Kind = params.get('report') === 'person' ? 'person' : 'monthly';
  const set = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };
  // A different report starts from its own questions.
  const show = (next: Kind) => setParams(next === 'person' ? new URLSearchParams({ report: 'person' }) : new URLSearchParams(), { replace: true });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p>{kind === 'monthly' ? 'A month, one row per person: the same numbers as each person’s calendar.' : 'One person’s days between two dates, and the stretch added up.'}</p>
        </div>
      </div>
      <Tabs
        name="reports"
        label="Report"
        value={kind}
        onChange={show}
        tabs={[
          { id: 'monthly', label: 'Monthly summary' },
          { id: 'person', label: 'One person' },
        ]}
      />
      <TabPanel name="reports" tab={kind}>
        {kind === 'monthly' ? <Monthly set={set} params={params} /> : <OnePerson set={set} params={params} />}
      </TabPanel>
    </>
  );
}
