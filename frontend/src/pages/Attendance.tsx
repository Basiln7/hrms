import { useState, type KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, List } from 'lucide-react';
import {
  addDays,
  addMonths,
  dayInWords,
  FLAG_LABEL,
  flagWords,
  HOLIDAY_YEAR_MAX,
  HOLIDAY_YEAR_MIN,
  localParts,
  MONTH_NAMES,
  monthGrid,
  isLocalDate,
  monthInWords,
  monthOf,
  STATUS_LABEL,
  WEEKDAY_NAMES,
  weekOrder,
  type AttendanceCalendarPayload,
  type DayResult,
  type LocalDate,
  type LocalMonth,
} from '@delta-hrms/shared';
import { DayRows, statusLook, SummaryTiles } from '../components/attendance';
import { DownloadButton } from '../components/reports';
import { LoadError, SkeletonLines } from '../components/states';
import { Empty, tone } from '../components/ui';
import { useAuth, useMe } from '../context/AuthContext';
import { queryOf, useLoad } from '../lib/useLoad';
import { DayDialog } from './attendance/DayDialog';
import { MyRequests } from './attendance/MyRequests';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a day says in one sentence, for a screen reader on a calendar cell. */
function inWords(day: DayResult, timeZone: string): string {
  const parts = [`${dayInWords(day.date)}: ${STATUS_LABEL[day.status]}`];
  if (day.holiday) parts.push(day.holiday.name);
  if (day.leave?.name) parts.push(day.leave.name);
  for (const flag of flagWords(day)) parts.push(flag.text);
  if (day.checkInAt) parts.push(`in ${localParts(day.checkInAt, timeZone).time}${day.checkOutAt ? `, out ${localParts(day.checkOutAt, timeZone).time}` : ''}`);
  return parts.join(', ');
}

/** One day of the month grid: its number, its status as icon and word, its times, and what else is true of it. */
function DayCell({ day, today, timeZone, onOpen }: { day: DayResult; today: LocalDate; timeZone: string; onOpen: (date: LocalDate) => void }) {
  const number = Number(day.date.slice(8, 10));
  if (day.status === 'not_applicable') {
    return (
      <div className="cal-cell" role="gridcell" data-off="true" aria-label={`${dayInWords(day.date)}: not counted`}>
        <span className="cal-num">{number}</span>
      </div>
    );
  }
  const { icon: Icon, color } = statusLook(day.status);
  // A working day still to come says nothing: the calendar stays quiet where there is nothing to report.
  const label = day.kind === 'holiday' && day.holiday ? day.holiday.name : day.status === 'leave' && day.leave?.name ? day.leave.name : STATUS_LABEL[day.status];
  const MARKED: readonly string[] = ['late', 'early_departure', 'worked_on_off_day', 'worked_on_leave', 'half_day_leave', 'corrected', 'pending_correction', 'pending_leave'];
  const marks = day.flags.filter((flag) => MARKED.includes(flag)).map((flag) => FLAG_LABEL[flag]);
  const time = (moment: string) => localParts(moment, timeZone).time;

  return (
    <div className="cal-cell" role="gridcell" data-today={day.date === today || undefined}>
      <button type="button" className="cal-day" data-date={day.date} style={tone(color)} aria-label={inWords(day, timeZone)} aria-current={day.date === today ? 'date' : undefined} onClick={() => onOpen(day.date)}>
        <span className="cal-num">{number}</span>
        {day.status !== 'upcoming' && (
          <span className="cal-status">
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </span>
        )}
        {day.kind !== 'holiday' && day.holiday && <span className="cal-note">{day.holiday.name}</span>}
        {day.checkInAt && <span className="cal-times">{day.checkOutAt ? `${time(day.checkInAt)}–${time(day.checkOutAt)}` : `${time(day.checkInAt)}–`}</span>}
        {marks.length > 0 && <span className="cal-marks">{marks.join(' · ')}</span>}
      </button>
    </div>
  );
}

/**
 * A month of attendance: every day as the engine reads it now, as a calendar and as a list,
 * with the month added up. Your own month, or, on a person's page, the month of someone you
 * are allowed to see: the server decides that, and answers "not found" for anyone else.
 */
export default function Attendance() {
  const { id } = useParams();
  const { employee: me, company } = useMe();
  const { can } = useAuth();
  // A link can name a day to open: "?day=2026-12-07", and "&ask=1" to go straight to asking for a correction.
  const [params, setParams] = useSearchParams();
  const linked = isLocalDate(params.get('day')) ? params.get('day') : null;
  // No month until the first answer says which month it is for this person, unless a link named a day.
  const [month, setMonth] = useState<LocalMonth | null>(linked ? monthOf(linked) : null);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [lateOnly, setLateOnly] = useState(false);
  const [open, setOpen] = useState<LocalDate | null>(linked);
  const [asking, setAsking] = useState(linked !== null && params.get('ask') === '1');
  // Raised whenever a request or a correction changes something, so the list of requests asks again too.
  const [changes, setChanges] = useState(0);
  const { data, error, reload } = useLoad<AttendanceCalendarPayload>(`/attendance/calendar${queryOf({ employeeId: id, month })}`);
  const closeDay = () => {
    setOpen(null);
    setAsking(false);
    // The link has done its work: without this, going back would open the day again.
    if (params.has('day')) setParams({}, { replace: true });
  };
  const changed = () => {
    reload();
    setChanges((n) => n + 1);
  };

  const mine = !id || id === me.id;
  const back = !mine && (
    <Link className="back" to={`/employees/${id}`}>
      <ArrowLeft size={16} /> {data?.employee.name ?? 'Back'}
    </Link>
  );

  if (error && !data) {
    return (
      <>
        {back}
        <section className="card">
          <LoadError message={error} onRetry={reload} />
        </section>
      </>
    );
  }
  if (!data) {
    return (
      <>
        {back}
        <section className="card">
          <SkeletonLines lines={8} />
        </section>
      </>
    );
  }

  const shown = data.month;
  const thisMonth = monthOf(data.today);
  const shownYear = Number(shown.slice(0, 4));
  const thisYear = Number(thisMonth.slice(0, 4));
  const years: number[] = [];
  for (let y = Math.max(HOLIDAY_YEAR_MIN, Math.min(thisYear - 5, shownYear)); y <= Math.min(HOLIDAY_YEAR_MAX, Math.max(thisYear + 1, shownYear)); y += 1) years.push(y);
  const canStep = (to: LocalMonth) => Number(to.slice(0, 4)) >= HOLIDAY_YEAR_MIN && Number(to.slice(0, 4)) <= HOLIDAY_YEAR_MAX;

  const byDate = new Map(data.days.map((day) => [day.date, day]));
  const weeks = monthGrid(shown, company.weekStartsOn);
  const s = data.summary;
  // The list is the days there is something to say about: up to today, and only those that apply.
  const listed = data.days.filter((day) => day.date <= data.today && day.status !== 'not_applicable' && (!lateOnly || day.flags.includes('late')));
  const applies = data.days.some((day) => day.status !== 'not_applicable');

  // Arrow keys move between days, as on any calendar.
  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-date]')?.dataset.date;
    if (!step || !from) return;
    // Over days that cannot be opened (before their first schedule), to the next one that can.
    for (let date = addDays(from, step); monthOf(date) === shown; date = addDays(date, step)) {
      const target = event.currentTarget.querySelector<HTMLElement>(`[data-date="${date}"]`);
      if (target) {
        event.preventDefault();
        target.focus();
        return;
      }
    }
  };

  return (
    <>
      {back}
      <div className="page-head">
        <div>
          <h1>{mine ? 'Attendance' : `${data.employee.name}’s attendance`}</h1>
          <p>
            {monthInWords(shown)} · {mine ? 'your days' : data.employee.code}, as they read now · {data.timeZone}
          </p>
        </div>
        <div className="head-actions">
          {/* One's own days are one's own to take away; someone else's need the permission to export. */}
          {applies && (mine || can('reports.export')) && (
            <DownloadButton small path={`/reports/employee/${data.employee.id}${queryOf({ from: data.days[0]!.date, to: data.days[data.days.length - 1]!.date, format: 'csv' })}`}>
              Download CSV
            </DownloadButton>
          )}
          <div className="segmented only-desktop" role="group" aria-label="Show as">
            <button type="button" aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>
              <LayoutGrid size={15} aria-hidden="true" /> Calendar
            </button>
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
              <List size={15} aria-hidden="true" /> List
            </button>
          </div>
        </div>
      </div>

      <div className="toolbar month-bar" role="group" aria-label="Month">
        <button type="button" className="icon-btn" aria-label={`Previous month, ${monthInWords(addMonths(shown, -1))}`} disabled={!canStep(addMonths(shown, -1))} onClick={() => setMonth(addMonths(shown, -1))}>
          <ChevronLeft size={18} />
        </button>
        <select className="select" aria-label="Month" value={Number(shown.slice(5, 7))} onChange={(e) => setMonth(`${shown.slice(0, 4)}-${String(e.target.value).padStart(2, '0')}`)}>
          {MONTH_NAMES.map((name, index) => (
            <option key={name} value={index + 1}>
              {name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Year" value={shownYear} onChange={(e) => setMonth(`${e.target.value}${shown.slice(4)}`)}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" aria-label={`Next month, ${monthInWords(addMonths(shown, 1))}`} disabled={!canStep(addMonths(shown, 1))} onClick={() => setMonth(addMonths(shown, 1))}>
          <ChevronRight size={18} />
        </button>
        <button type="button" className="btn ghost sm" disabled={shown === thisMonth} onClick={() => setMonth(null)}>
          <CalendarDays size={15} aria-hidden="true" /> This month
        </button>
      </div>

      {!applies ? (
        <section className="card">
          <Empty icon={<CalendarDays size={30} />} title={`Nothing is counted in ${monthInWords(shown)}`} body={mine ? 'Attendance counts from your first day on a work schedule, and only while you are employed. This month is outside that.' : 'Attendance counts from their first day on a work schedule, and only while they are employed. This month is outside that.'} />
        </section>
      ) : (
        <div className="att" data-view={view}>
          <section className="card" aria-label="The month in numbers" style={{ marginBottom: 18 }}>
            <SummaryTiles summary={s} />
            <p className="tiles-foot">
              {count(s.workingDays, 'working day', 'working days')} counted · {count(s.holidays, 'holiday', 'holidays')} · {count(s.weeklyOffs, 'weekly off', 'weekly offs')}
              {s.unresolvedDays > 0 ? ` · ${count(s.unresolvedDays, 'day', 'days')} with no check-out, not yet counted either way` : ''}
              {s.halfDays > 0 ? '. Absent includes the half that is missing from each half-day.' : '.'}
            </p>
          </section>

          <section className="card att-grid" aria-label={`${monthInWords(shown)} as a calendar`}>
            <div className="cal" role="grid" aria-label={monthInWords(shown)} onKeyDown={onGridKey}>
              <div className="cal-week cal-head" role="row">
                {weekOrder(company.weekStartsOn).map((weekday) => (
                  <span key={weekday} role="columnheader" aria-label={WEEKDAY_NAMES[weekday]}>
                    {WEEKDAY_NAMES[weekday].slice(0, 3)}
                  </span>
                ))}
              </div>
              {weeks.map((week, index) => (
                <div className="cal-week" role="row" key={index}>
                  {week.map((date, column) => {
                    const day = date ? byDate.get(date) : undefined;
                    return day ? <DayCell key={day.date} day={day} today={data.today} timeZone={data.timeZone} onOpen={setOpen} /> : <div className="cal-cell" role="gridcell" data-blank="true" key={`blank-${column}`} />;
                  })}
                </div>
              ))}
            </div>
          </section>

          <section className="card att-list" aria-label={`${monthInWords(shown)} as a list`}>
            <div className="card-head">
              <div>
                <h2 className="card-title">Day by day</h2>
                <p className="card-sub">{lateOnly ? count(listed.length, 'late entry', 'late entries') : 'Every day so far, in order. Open one for its times and history.'}</p>
              </div>
              <label className="check">
                <input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} />
                Late entries only
              </label>
            </div>
            {listed.length === 0 ? <p className="muted">{lateOnly ? `No late entries in ${monthInWords(shown)}.` : `Nothing has happened yet in ${monthInWords(shown)}.`}</p> : <DayRows days={listed} timeZone={data.timeZone} onOpen={setOpen} />}
          </section>
        </div>
      )}

      {mine && <MyRequests key={changes} timeZone={data.timeZone} onOpen={(date) => {
        setMonth(monthOf(date));
        setOpen(date);
      }} onChanged={changed} />}

      {open && <DayDialog employeeId={data.employee.id} date={open} timeZone={data.timeZone} asking={asking} onClose={closeDay} onChanged={changed} />}
    </>
  );
}
