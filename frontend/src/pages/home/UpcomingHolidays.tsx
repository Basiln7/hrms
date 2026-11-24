import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { daysBetween, type LocalDate, type MyDashboardPayload } from '@delta-hrms/shared';
import { HolidayBadge } from '../../components/attendance';
import { shortDay } from '../../lib/format';

const away = (days: number) => (days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`);

/**
 * The next holidays on the person's calendar. Shown only to someone who is on a calendar:
 * for anyone else there is nothing to say here, and the Holidays page says why.
 */
export function UpcomingHolidays({ holidays, today }: { holidays: MyDashboardPayload['holidays']; today: LocalDate }) {
  if (!holidays.calendarName) return null;
  return (
    <section className="card" aria-labelledby="home-holidays">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="home-holidays">
            Upcoming holidays
          </h2>
          <p className="card-sub">{holidays.calendarName}</p>
        </div>
        <Link className="link" to="/holidays">
          All holidays <ArrowRight size={15} />
        </Link>
      </div>
      {holidays.upcoming.length === 0 ? (
        <p className="muted">No holidays are on your calendar for the coming year yet.</p>
      ) : (
        <ul className="upcoming">
          {holidays.upcoming.map((h) => (
            <li key={h.date}>
              <div>
                <b>{h.name}</b>
                <span>
                  {shortDay(h.date)} · {away(daysBetween(today, h.date))}
                </span>
              </div>
              <HolidayBadge type={h.type} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
