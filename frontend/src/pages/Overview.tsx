import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight, Search, UsersRound } from 'lucide-react';
import { addDays, dayInWords, isLocalDate, OVERVIEW_FILTERS, OVERVIEW_INFO, type OverviewFilter, type OverviewPayload } from '@delta-hrms/shared';
import { HolidayBadge } from '../components/attendance';
import { DayCells, DepartmentSelect, ManagerSelect, PersonCell, useReportPeople } from '../components/reports';
import { LoadError, SkeletonLines } from '../components/states';
import { Empty, Pager } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { shortDay } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';

/** The numbers shown large, always. The rest are shown when they are not zero. */
const MAIN: readonly OverviewFilter[] = ['all', 'checked_in', 'working', 'absent', 'late', 'leave'];
const MORE: readonly OverviewFilter[] = ['present', 'half_day', 'unresolved', 'not_due', 'day_off', 'upcoming', 'not_counted'];
const isFilter = (value: string | null): value is OverviewFilter => OVERVIEW_FILTERS.includes(value as OverviewFilter);

/** How often the page asks again while today is being looked at. */
const REFRESH_MS = 60_000;

/**
 * One day for everyone the signed-in person may see: everyone for HR and Admin, their team
 * for a Manager. Each number is counted by the server over those people, with the same
 * function that reads a day anywhere else, and each opens the list of the people behind it.
 */
export default function Overview() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const asked = {
    date: isLocalDate(params.get('date')) ? params.get('date')! : '',
    departmentId: params.get('departmentId') ?? '',
    managerId: params.get('managerId') ?? '',
    filter: isFilter(params.get('filter')) ? (params.get('filter') as OverviewFilter) : 'all',
    search: params.get('search') ?? '',
    page: Number(params.get('page') ?? '1') || 1,
  };
  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };

  // Typing does not ask the server on every letter.
  const [typed, setTyped] = useState(asked.search);
  useEffect(() => {
    if (typed === asked.search) return;
    const timer = window.setTimeout(() => set({ search: typed.trim() }), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const { data, error, reload } = useLoad<OverviewPayload>(`/dashboard/hr${queryOf({ ...asked, filter: asked.filter === 'all' ? undefined : asked.filter, page: asked.page > 1 ? asked.page : undefined })}`);
  const people = useReportPeople();

  // Today changes by the minute. A day that is over does not.
  const live = data !== null && data.date === data.today;
  useEffect(() => {
    if (!live) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') reload();
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, reload]);

  const team = data?.scope === 'team';
  const date = data?.date ?? asked.date;
  const shown = (filter: OverviewFilter) => MAIN.includes(filter) || (data !== null && (data.counts[filter] > 0 || data.filter === filter));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{team ? 'Team overview' : 'Overview'}</h1>
          <p>
            {data ? `${dayInWords(data.date)} ${data.date.slice(0, 4)}${live ? ' · today, as it reads now' : data.date > data.today ? ' · still to come' : ' · as it reads now'}` : 'One day, for everyone you may see.'}
            {team ? ' · the people who report to you' : ''}
          </p>
        </div>
      </div>

      <div className="toolbar" role="group" aria-label="Day and people">
        <div className="date-step">
          <button type="button" className="icon-btn" aria-label="The day before" disabled={!date} onClick={() => set({ date: addDays(date, -1) })}>
            <ChevronLeft size={18} />
          </button>
          <input className="input" type="date" aria-label="Day" value={date} onChange={(e) => set({ date: e.target.value })} />
          <button type="button" className="icon-btn" aria-label="The day after" disabled={!date} onClick={() => set({ date: addDays(date, 1) })}>
            <ChevronRight size={18} />
          </button>
          <button type="button" className="btn ghost sm" disabled={!data || live} onClick={() => set({ date: '' })}>
            Today
          </button>
        </div>
        <DepartmentSelect value={asked.departmentId} onChange={(id) => set({ departmentId: id })} />
        <ManagerSelect people={people.data} value={asked.managerId} onChange={(id) => set({ managerId: id })} />
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
        <>
          <div className="overview-tiles" role="group" aria-label="Show the people behind a number">
            {[...MAIN, ...MORE].filter(shown).map((filter) => (
              <button key={filter} type="button" className="tile-btn" data-main={MAIN.includes(filter) || undefined} aria-pressed={data.filter === filter} title={OVERVIEW_INFO[filter].hint} onClick={() => set({ filter: filter === 'all' ? '' : filter })}>
                <b>{data.counts[filter]}</b>
                <span>{OVERVIEW_INFO[filter].label}</span>
              </button>
            ))}
          </div>

          <div className="grid">
            <section className="card col-12" aria-labelledby="overview-list">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="overview-list">
                    {OVERVIEW_INFO[data.filter].label}
                  </h2>
                  <p className="card-sub">
                    {OVERVIEW_INFO[data.filter].hint} {data.people.total} {data.people.total === 1 ? 'person' : 'people'}
                    {asked.search ? ' match' : ''}.
                  </p>
                </div>
                <span className="input-icon">
                  <Search size={17} />
                  <input className="input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Name or code" aria-label="Search the list" />
                </span>
              </div>
              {data.people.items.length === 0 ? (
                <Empty icon={<UsersRound size={30} />} title={data.counts.all === 0 ? 'Nobody to show' : 'Nobody here'} body={data.counts.all === 0 ? (team ? 'Nobody reports to you, or nobody matches these filters.' : 'Nobody matches these filters.') : asked.search ? 'Nobody in this group matches the search.' : 'Nobody is in this group on this day.'} />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Person</th>
                        <th scope="col">Department</th>
                        <th scope="col">Day</th>
                        <th scope="col">Times</th>
                        <th scope="col">Worked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.people.items.map((row) => (
                        <tr key={row.id} className="clickable" onClick={() => navigate(`/employees/${row.id}/attendance?day=${row.day.date}`)}>
                          <td>
                            <PersonCell person={row} />
                          </td>
                          <td className={row.departmentName ? undefined : 'cell-none'}>
                            {row.departmentName ?? 'None'}
                            {row.day.date !== data.date && <span className="cell-sub">Shift of {shortDay(row.day.date)}</span>}
                          </td>
                          <DayCells day={row.day} timeZone={row.timeZone} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pager page={data.people.page} pages={Math.max(1, Math.ceil(data.people.total / data.people.pageSize))} total={data.people.total} pageSize={data.people.pageSize} onPage={(page) => set({ page: String(page) })} noun="people" />
            </section>

            {(can('team.approve') || can('requests.approveAll')) && (
              <section className="card col-6" aria-labelledby="overview-waiting">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="overview-waiting">
                      Waiting for your decision
                    </h2>
                    <p className="card-sub">Requests only you, or someone like you, can decide</p>
                  </div>
                  <Link className="link" to="/approvals">
                    Approvals <ArrowRight size={15} />
                  </Link>
                </div>
                <dl className="tiles two">
                  <div>
                    <dt>Leave</dt>
                    <dd>{data.waiting.leave}</dd>
                  </div>
                  <div>
                    <dt>Corrections</dt>
                    <dd>{data.waiting.corrections}</dd>
                  </div>
                </dl>
              </section>
            )}

            <section className="card col-6" aria-labelledby="overview-holidays">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="overview-holidays">
                    Upcoming holidays
                  </h2>
                  <p className="card-sub">On the calendars of the people in view, from this day on</p>
                </div>
              </div>
              {data.holidays.length === 0 ? (
                <p className="muted">None of these people has a holiday coming up on their calendar.</p>
              ) : (
                <ul className="upcoming">
                  {data.holidays.map((holiday) => (
                    <li key={`${holiday.calendarName}|${holiday.date}`}>
                      <div>
                        <b>{holiday.name}</b>
                        <span>
                          {shortDay(holiday.date)} · {holiday.calendarName}
                        </span>
                      </div>
                      <HolidayBadge type={holiday.type} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
