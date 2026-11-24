import { useState } from 'react';
import { TreePalm } from 'lucide-react';
import { approverInWords, daysInWords, type LeaveBalancesPayload } from '@delta-hrms/shared';
import { BalanceCards, EntriesTable, LeaveRequestList, RequestLeaveButton, RequestLeaveDialog } from '../components/leave';
import { LoadError, SkeletonLines } from '../components/states';
import { Empty } from '../components/ui';
import { useMe } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { dayDate } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';

/**
 * The signed-in person's own leave: what is left of each kind this leave year, asking for
 * leave, and what became of every request. It takes no employee: it is always your own.
 */
export default function Leave() {
  const { company } = useMe();
  const toast = useToast();
  const [year, setYear] = useState<number | undefined>();
  const account = useLoad<LeaveBalancesPayload>(`/leave/balances${queryOf({ year })}`);
  const [asking, setAsking] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const a = account.data;
  const canAsk = Boolean(a?.policy) && (a?.rows.some((row) => row.entry !== null && !row.type.archived) ?? false);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leave</h1>
          <p>{a?.policy ? `Your leave policy is “${a.policy.name}”. Requests are approved by ${approverInWords(a.policy.approver, 'your')}.` : 'What is left of each kind of leave, and your requests.'}</p>
        </div>
        <div className="head-actions">
          {a && a.years.length > 1 && (
            <select className="select" aria-label="Leave year" value={a.leaveYear} onChange={(e) => setYear(Number(e.target.value))}>
              {a.years.map((y) => (
                <option key={y.year} value={y.year}>
                  {y.label}
                  {y.year === a.currentYear ? ' (now)' : ''}
                </option>
              ))}
            </select>
          )}
          {canAsk && <RequestLeaveButton onClick={() => setAsking(true)} />}
        </div>
      </div>

      <section className="card" aria-labelledby="leave-balances" style={{ marginBottom: 18 }}>
        {account.error && !a ? (
          <LoadError message={account.error} onRetry={account.reload} />
        ) : !a ? (
          <SkeletonLines lines={5} />
        ) : (
          <>
            <div className="card-head">
              <div>
                <h2 className="card-title" id="leave-balances">
                  Leave year {a.yearLabel}
                </h2>
                <p className="card-sub">
                  {dayDate(a.range.from)} to {dayDate(a.range.to)}
                  {a.leaveYear > a.currentYear ? ' · not started yet: what is carried forward from this year is added on its first day' : ''}
                </p>
              </div>
            </div>
            {a.rows.length === 0 ? (
              <Empty icon={<TreePalm size={30} />} title={a.policy ? 'Nothing has been granted for this leave year' : 'You are not on a leave policy yet'} body={a.policy ? 'Ask HR if that is not what you expect.' : 'HR puts each person on a leave policy. Until then no leave is granted and none can be asked for.'} />
            ) : (
              <BalanceCards rows={a.rows} />
            )}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="leave-requests" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <div>
            <h2 className="card-title" id="leave-requests">
              My requests
            </h2>
            <p className="card-sub">Newest first. A request can be cancelled while it waits, and after approval until its first day.</p>
          </div>
        </div>
        <LeaveRequestList key={listVersion} query="?view=mine" own timeZone={company.timeZone} onChanged={account.reload} empty={{ title: 'No leave asked for yet', body: canAsk ? 'Use “Request leave” to ask for your first days off.' : 'Your requests will be listed here.' }} />
      </section>

      {a && a.entries.length > 0 && (
        <section className="card" aria-labelledby="leave-account">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="leave-account">
                What was added to your account
              </h2>
              <p className="card-sub">The year’s allowance, what was carried forward, and any adjustment HR made, with its reason.</p>
            </div>
          </div>
          <EntriesTable entries={a.entries} timeZone={company.timeZone} />
        </section>
      )}

      {asking && a && (
        <RequestLeaveDialog
          account={a}
          onClose={() => setAsking(false)}
          onSent={(request) => {
            toast(`Your request for ${daysInWords(request.days)} is sent. The days are held until it is decided.`);
            account.reload();
            setListVersion((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
