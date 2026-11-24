import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { FLAG_LABEL, formatMinutes, isLocalDate, RECORD_FLAGS, RECORD_STATUSES, STATUS_LABEL, WEEKDAY_NAMES, weekdayOf, type DayFlag, type RecordsPayload, type RecordStatus } from '@delta-hrms/shared';
import { DayCells, DepartmentSelect, DownloadButton, ManagerSelect, PersonCell, PersonSelect, useReportPeople } from '../components/reports';
import { LoadError, SkeletonLines } from '../components/states';
import { Empty, Pager } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { dayDate } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';

const STATUS_WORDS: Record<RecordStatus, string> = { ...STATUS_LABEL, working: 'Working or on a break' } as Record<RecordStatus, string>;

/**
 * Everyone's days between two dates, for those who may see reports: narrowed by people, by
 * how the day reads and by what is marked on it. Beside it, who was late how often in the
 * same stretch. The same rows can be downloaded as a file.
 */
export default function Records() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const date = (name: string) => (isLocalDate(params.get(name)) ? params.get(name)! : '');
  const asked = {
    from: date('from'),
    to: date('to'),
    departmentId: params.get('departmentId') ?? '',
    managerId: params.get('managerId') ?? '',
    employeeId: params.get('employeeId') ?? '',
    status: RECORD_STATUSES.includes(params.get('status') as RecordStatus) ? params.get('status')! : '',
    flag: RECORD_FLAGS.includes(params.get('flag') as DayFlag) ? params.get('flag')! : '',
  };
  const page = Number(params.get('page') ?? '1') || 1;
  const set = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const filtered = Object.values(asked).some(Boolean);

  const { data, error, reload } = useLoad<RecordsPayload>(`/attendance/records${queryOf({ ...asked, page: page > 1 ? page : undefined })}`);
  const people = useReportPeople();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Attendance records</h1>
          <p>{data ? `${dayDate(data.from)} to ${dayDate(data.to)} · ${data.total} ${data.total === 1 ? 'day' : 'days'}, each as it reads now` : 'Everyone’s days, as they read now.'}</p>
        </div>
        {can('reports.export') && (
          <div className="head-actions">
            <DownloadButton path={`/attendance/records${queryOf({ ...asked, format: 'csv' })}`}>Download CSV</DownloadButton>
          </div>
        )}
      </div>

      <div className="toolbar" role="group" aria-label="Filters">
        <label className="dated">
          <span>From</span>
          <input className="input" type="date" value={asked.from || data?.from || ''} max={asked.to || data?.to} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="dated">
          <span>To</span>
          <input className="input" type="date" value={asked.to || data?.to || ''} min={asked.from || data?.from} onChange={(e) => set('to', e.target.value)} />
        </label>
        <DepartmentSelect value={asked.departmentId} onChange={(id) => set('departmentId', id)} />
        <ManagerSelect people={people.data} value={asked.managerId} onChange={(id) => set('managerId', id)} />
        <PersonSelect people={people.data} value={asked.employeeId} onChange={(id) => set('employeeId', id)} none="Everyone" />
        <select className="select" aria-label="How the day reads" value={asked.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option>
          {RECORD_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_WORDS[status]}
            </option>
          ))}
        </select>
        <select className="select" aria-label="What is marked on the day" value={asked.flag} onChange={(e) => set('flag', e.target.value)}>
          <option value="">Any mark</option>
          {RECORD_FLAGS.map((flag) => (
            <option key={flag} value={flag}>
              {FLAG_LABEL[flag]}
            </option>
          ))}
        </select>
        {filtered && (
          <button type="button" className="btn ghost sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      {error && !data ? (
        <section className="card">
          <LoadError message={error} onRetry={reload} />
        </section>
      ) : !data ? (
        <section className="card">
          <SkeletonLines lines={8} />
        </section>
      ) : (
        <div className="grid">
          <section className="card col-12" aria-label="Days">
            {data.items.length === 0 ? (
              <Empty icon={<ClipboardList size={30} />} title="No days match" body={filtered ? 'Try other dates or fewer filters. Days off on which nothing happened are listed only when you ask for them by status.' : 'Nothing has been counted in this stretch yet.'} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Person</th>
                      <th scope="col">Day</th>
                      <th scope="col">Times</th>
                      <th scope="col">Worked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row) => (
                      <tr key={`${row.id}|${row.day.date}`} className="clickable" onClick={() => navigate(`/employees/${row.id}/attendance?day=${row.day.date}`)}>
                        <td className="nowrap">
                          {dayDate(row.day.date)}
                          <span className="cell-sub">{WEEKDAY_NAMES[weekdayOf(row.day.date)]}</span>
                        </td>
                        <td>
                          <PersonCell person={row} />
                        </td>
                        <DayCells day={row.day} timeZone={row.timeZone} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager page={data.page} pages={Math.max(1, Math.ceil(data.total / data.pageSize))} total={data.total} pageSize={data.pageSize} onPage={(next) => set('page', String(next))} noun="days" />
          </section>

          <section className="card col-12" aria-labelledby="records-late">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="records-late">
                  Late entries
                </h2>
                <p className="card-sub">In these dates, for the people in view, most often first</p>
              </div>
            </div>
            {data.late.length === 0 ? (
              <p className="muted">Nobody was late in this stretch.</p>
            ) : (
              <ul className="upcoming late-list">
                {data.late.map((row) => (
                  <li key={row.id}>
                    <div>
                      <b>
                        <button type="button" className="link" onClick={() => setParams(new URLSearchParams({ ...(asked.from ? { from: asked.from } : {}), ...(asked.to ? { to: asked.to } : {}), employeeId: row.id, flag: 'late' }), { replace: true })}>
                          {row.name}
                        </button>
                      </b>
                      <span>
                        {formatMinutes(row.minutes)} late in all
                        {row.excused > 0 ? ` · ${row.excused} excused` : ''}
                      </span>
                    </div>
                    <b className="num late-count">
                      {row.entries} {row.entries === 1 ? 'time' : 'times'}
                    </b>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
