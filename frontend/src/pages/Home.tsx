import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Building2 } from 'lucide-react';
import { formatMinutes, localParts, ROLE_INFO, WEEKDAY_NAMES, type MyDashboardPayload, type TodayPayload } from '@delta-hrms/shared';
import { LoadError, SkeletonLines } from '../components/states';
import { Avatar, Badge, tone } from '../components/ui';
import { useAuth, useMe } from '../context/AuthContext';
import { firstName, greeting, longDate, monthName } from '../lib/format';
import { syncServerClock, useServerNow } from '../lib/serverClock';
import { useLoad } from '../lib/useLoad';
import { AnnouncementsCard } from './home/AnnouncementsCard';
import { LeaveCard } from './home/LeaveCard';
import { MonthCard } from './home/MonthCard';
import { RecentDays } from './home/RecentDays';
import { TodayCard } from './home/TodayCard';
import { UpcomingHolidays } from './home/UpcomingHolidays';
import { WaitingRequests } from './home/WaitingRequests';

/** How often the page asks the server again while it is being looked at. */
const REFRESH_MS = 60_000;

/** A label and its value. A value that has not been set is written out as such, not left blank. */
function Fact({ label, value, none }: { label: string; value: string | null | undefined; none: string }) {
  return (
    <div>
      <dt>{label}</dt>
      {value ? <dd>{value}</dd> : <dd className="none">{none}</dd>}
    </div>
  );
}

/** The hours of the day the Today card shows, or that it is a day off. */
function hoursOf(today: TodayPayload | null): string | null {
  if (!today || today.day.kind === null) return null;
  if (!today.hours) return 'Day off';
  return today.hours.start && today.hours.end ? `${today.hours.start} to ${today.hours.end}` : `Flexible, ${formatMinutes(today.hours.requiredMinutes)}`;
}

/**
 * The employee's home page: today, with the check-in and check-out buttons; this month so
 * far; the last few days. Everything about attendance comes from one request, read by the
 * server at one moment, so the blocks cannot disagree with each other.
 */
export default function Home() {
  const { can } = useAuth();
  const { employee, company, scheduleName } = useMe();
  const { data, error, loading, reload } = useLoad<MyDashboardPayload>('/dashboard/me');
  // A punch answers with the new state at once; the rest of the page follows a moment later.
  const [punched, setPunched] = useState<TodayPayload | null>(null);

  useEffect(() => {
    if (data) syncServerClock(data.today.serverNow);
  }, [data]);

  // What is true changes with the time alone (check-in opens, the grace runs out, a day can no
  // longer be closed), and the server decides all of it. So ask again every minute while the
  // page is being looked at, and straight away when someone comes back to it.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') reload();
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);

  // Whichever of the two the server said last.
  const today = punched && (!data || punched.serverNow > data.today.serverNow) ? punched : (data?.today ?? null);
  // Today is the server's today, in the zone of the person's own schedule. The device's clock plays no part.
  const now = useServerNow();
  const timeZone = today?.timeZone ?? company.timeZone;
  const here = localParts(now, timeZone);
  const counted = data !== null && (today?.rules != null || data.recent.length > 0 || data.month.summary.workingDays > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {greeting(here.hour)}, {firstName(employee.name)}
          </h1>
          <p>
            {longDate(now, timeZone)} · {timeZone}
          </p>
        </div>
      </div>

      <div className="grid">
        <div className="stack col-7">
          {today ? (
            <TodayCard
              today={today}
              onChanged={(after) => {
                setPunched(after);
                reload();
              }}
              onStale={reload}
            />
          ) : (
            <section className="card" aria-label="Today">
              {error && !loading ? <LoadError message={error} onRetry={reload} /> : <SkeletonLines lines={5} />}
            </section>
          )}
          {data && data.corrections.length + data.leave.waiting.length > 0 && <WaitingRequests requests={data.corrections} leave={data.leave.waiting} timeZone={timeZone} />}
          {data && counted && <MonthCard month={data.month} />}
          {data && counted && <RecentDays days={data.recent} timeZone={timeZone} />}
        </div>

        <div className="stack col-5">
          <section className="card" aria-labelledby="home-me">
            <div className="card-head">
              <div className="person">
                <Avatar name={employee.name} size={52} />
                <div className="person-main">
                  <b id="home-me">{employee.name}</b>
                  <span>{employee.designation || 'No designation set'}</span>
                </div>
              </div>
              <Badge color={ROLE_INFO[employee.role].tone} dot>
                {employee.role}
              </Badge>
            </div>
            <dl className="facts">
              <Fact label="Employee code" value={employee.code} none="" />
              <Fact label="Department" value={employee.departmentName} none="Not assigned yet" />
              <Fact label="Reports to" value={employee.managerName} none="Nobody" />
              <Fact label="Work schedule" value={today?.rules?.name ?? scheduleName} none="None yet" />
              {hoursOf(today) && <Fact label={today && today.day.date !== today.today ? 'This shift' : 'Today'} value={hoursOf(today)} none="" />}
            </dl>
            <div className="form-actions">
              <Link className="link" to="/profile">
                My profile and schedule <ArrowRight size={15} />
              </Link>
            </div>
          </section>

          {data && <AnnouncementsCard announcements={data.announcements} timeZone={company.timeZone} onRead={reload} />}
          {data && <LeaveCard leave={data.leave} />}
          {data && today && <UpcomingHolidays holidays={data.holidays} today={today.today} />}

          {can('settings.manage') && (
            <section className="card" aria-labelledby="home-company">
              <div className="card-head with-icon">
                <span className="card-icon" style={tone('var(--accent-text)')}>
                  <Building2 size={19} />
                </span>
                <div>
                  <h2 className="card-title" id="home-company">
                    {company.name || 'Your company'}
                  </h2>
                  <p className="card-sub">Company settings</p>
                </div>
              </div>
              <dl className="facts">
                <Fact label="Time zone" value={company.timeZone} none="" />
                <Fact label="Leave year starts" value={monthName(company.leaveYearStartMonth)} none="" />
                <Fact label="Week starts on" value={company.weekStartsOn === 'sunday' ? WEEKDAY_NAMES.sun : WEEKDAY_NAMES.mon} none="" />
              </dl>
              <div className="form-actions">
                <Link className="link" to="/settings">
                  Change settings <ArrowRight size={15} />
                </Link>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
