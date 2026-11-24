import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { daysInWords, LEAVE_TONE_COLOR, type MyDashboardPayload } from '@delta-hrms/shared';
import { leaveRange } from '../../components/leave';
import { tone } from '../../components/ui';
import { dayCount } from '../../lib/format';

/**
 * The person's leave at a glance: what is left of each kind this leave year, and approved
 * leave that is still to come. Shown only to someone who is on a leave policy or has leave
 * ahead: for anyone else there is nothing to say here, and the Leave page says why.
 */
export function LeaveCard({ leave }: { leave: MyDashboardPayload['leave'] }) {
  if (!leave.hasPolicy && leave.upcoming.length === 0) return null;
  return (
    <section className="card" aria-labelledby="home-leave">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="home-leave">
            Leave
          </h2>
          <p className="card-sub">Leave year {leave.yearLabel}</p>
        </div>
        <Link className="link" to="/leave">
          Request leave <ArrowRight size={15} />
        </Link>
      </div>
      {leave.balances.length === 0 ? (
        <p className="muted">Your leave policy grants nothing yet for this leave year.</p>
      ) : (
        <ul className="leave-mini">
          {leave.balances.map(({ type, balance }) => (
            <li key={type.id} style={tone(LEAVE_TONE_COLOR[type.tone])}>
              <span className="leave-name">
                <i aria-hidden="true" />
                {type.name}
              </span>
              <b className="num">{type.paid ? `${dayCount(balance.available)} left` : `${dayCount(balance.taken + balance.held)} used`}</b>
            </li>
          ))}
        </ul>
      )}
      {leave.upcoming.length > 0 && (
        <>
          <h3 className="subhead">Approved leave coming up</h3>
          <ul className="upcoming">
            {leave.upcoming.map((row) => (
              <li key={row.id}>
                <div>
                  <b>{leaveRange(row)}</b>
                  <span>
                    {row.typeName} · {daysInWords(row.days)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
