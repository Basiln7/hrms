import { Link } from 'react-router-dom';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { monthInWords, monthOf, type MyDashboardPayload } from '@delta-hrms/shared';
import { SummaryTiles } from '../../components/attendance';
import { dayCount } from '../../lib/format';

const plural = (count: number, one: string, many: string) => `${dayCount(count)} ${count === 1 ? one : many}`;

/** This month so far, in numbers the engine added up. */
export function MonthCard({ month }: { month: MyDashboardPayload['month'] }) {
  const s = month.summary;
  const name = monthInWords(monthOf(month.from));
  const nothingYet = s.workingDays === 0 && s.workedMinutes === 0 && s.lateEntries === 0;

  return (
    <section className="card" aria-labelledby="home-month">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="home-month">
            This month
          </h2>
          <p className="card-sub">{nothingYet ? name : `${name} · ${plural(s.workingDays, 'working day', 'working days')} counted so far`}</p>
        </div>
        <Link className="link" to="/attendance">
          Calendar <ArrowRight size={15} />
        </Link>
      </div>

      {nothingYet ? (
        <p className="muted">Nothing is counted yet this month. A working day is counted once it is over, or once you have checked out.</p>
      ) : (
        <>
          <SummaryTiles summary={s} />
          {s.unresolvedDays > 0 && (
            <p className="note warn">
              <TriangleAlert size={16} aria-hidden="true" />
              <span>
                {plural(s.unresolvedDays, 'day has', 'days have')} a check-in with no check-out. {s.unresolvedDays === 1 ? 'It is' : 'They are'} counted as neither present nor absent until corrected.
              </span>
            </p>
          )}
          <p className="tiles-foot">
            {s.halfDays > 0 ? 'Absent includes the half that is missing from each half-day. ' : ''}
            Time worked counts the days you have checked out of{s.offDaysWorked > 0 ? `, ${plural(s.offDaysWorked, 'day off', 'days off')} included` : ''}.
          </p>
        </>
      )}
    </section>
  );
}
