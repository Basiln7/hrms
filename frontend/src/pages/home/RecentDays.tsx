import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { RECENT_DAYS, type DayResult } from '@delta-hrms/shared';
import { DayRows } from '../../components/attendance';

/** The days before today, newest first, each exactly as the engine reads it now. */
export function RecentDays({ days, timeZone }: { days: DayResult[]; timeZone: string }) {
  return (
    <section className="card" aria-labelledby="home-recent">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="home-recent">
            Recent days
          </h2>
          <p className="card-sub">The last {RECENT_DAYS} days before today</p>
        </div>
        <Link className="link" to="/attendance">
          All days <ArrowRight size={15} />
        </Link>
      </div>

      {days.length === 0 ? <p className="muted">No earlier days yet. They appear here from your first day on a work schedule.</p> : <DayRows days={days} timeZone={timeZone} />}
    </section>
  );
}
