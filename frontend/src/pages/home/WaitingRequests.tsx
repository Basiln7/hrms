import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { changeInWords, CORRECTION_INFO, daysInWords, type CorrectionRequest, type LeaveRow } from '@delta-hrms/shared';
import { leaveRange } from '../../components/leave';
import { shortDate, shortDay } from '../../lib/format';

/** The signed-in person's own requests that nobody has decided yet: leave and corrections. Shown only when there are some. */
export function WaitingRequests({ requests, leave, timeZone }: { requests: CorrectionRequest[]; leave: LeaveRow[]; timeZone: string }) {
  const total = requests.length + leave.length;
  return (
    <section className="card" aria-labelledby="home-waiting">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="home-waiting">
            Waiting for a decision
          </h2>
          <p className="card-sub">{total === 1 ? 'One request you made' : `${total} requests you made`}</p>
        </div>
        <Link className="link" to={leave.length > 0 ? '/leave' : '/attendance'}>
          All requests <ArrowRight size={15} />
        </Link>
      </div>
      <ul className="upcoming">
        {leave.map((row) => (
          <li key={row.id}>
            <div>
              <b>
                <Link to="/leave">{leaveRange(row)}</Link>
              </b>
              <span>
                {row.typeName}, {daysInWords(row.days)} · asked on {shortDate(row.submittedAt, timeZone)}
              </span>
            </div>
          </li>
        ))}
        {requests.map((request) => {
          const asked = changeInWords(request.requested, request.date, timeZone).join(' · ');
          return (
            <li key={request.id}>
              <div>
                <b>
                  <Link to={`/attendance?day=${request.date}`}>{shortDay(request.date)}</Link>
                </b>
                <span>
                  {CORRECTION_INFO[request.type].label}
                  {asked ? `: ${asked.toLowerCase()}` : ''} · asked on {shortDate(request.submittedAt, timeZone)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
