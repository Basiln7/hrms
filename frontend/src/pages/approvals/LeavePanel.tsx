import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { daysInWords, REASON_MAX, type LeaveInboxItem, type LeaveListPayload, type LeaveRequest, type LeaveRow } from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { CancelLeaveDialog, LeaveBadge, leaveRange, LeaveStatusBadge } from '../../components/leave';
import { LoadError, SkeletonLines } from '../../components/states';
import { Avatar, Empty, Modal, Pager } from '../../components/ui';
import { useMe } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { api, ApiError, messageOf } from '../../lib/api';
import { dayCount, shortDate, shortDay } from '../../lib/format';
import { queryOf, useLoad } from '../../lib/useLoad';

/** Approve or reject one leave request. A rejection needs its reason; an approval may carry a comment. */
function DecideDialog({ item, approving, onClose, onDecided, onStale }: { item: LeaveInboxItem; approving: boolean; onClose: () => void; onDecided: (request: LeaveRequest) => void; onStale: (message: string) => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!approving && !note.trim()) {
      setError('Say why the request is rejected.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setFailure(null);
    try {
      onDecided(await api.post<LeaveRequest>(`/leave/requests/${item.id}/${approving ? 'approve' : 'reject'}`, { note }));
      onClose();
    } catch (failed) {
      // Someone else decided first, or it was cancelled meanwhile: what is on screen is out of date.
      if (failed instanceof ApiError && (failed.status === 409 || failed.status === 404)) {
        onStale(messageOf(failed));
        onClose();
        return;
      }
      setFailure(messageOf(failed));
      setBusy(false);
    }
  };

  const what = `${daysInWords(item.days)} of ${item.typeName} (${leaveRange(item)})`;
  return (
    <Modal
      title={approving ? `Approve ${item.employeeName}’s leave?` : `Reject ${item.employeeName}’s leave?`}
      onClose={onClose}
      width={480}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className={approving ? 'btn' : 'btn danger'} disabled={busy}>
            {busy ? 'Saving…' : approving ? 'Approve' : 'Reject'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginBottom: 14 }}>
        {approving ? `${what} becomes approved leave: those days read as leave in their calendar, and the days come off their balance.` : `${what} is not granted, and the days are available to them again. ${item.employeeName} sees your reason.`}
      </p>
      <FormField label={approving ? 'Comment' : 'Reason'} aside={approving ? 'optional' : undefined} required={!approving} error={error}>
        {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={REASON_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
      </FormField>
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** What approving would do to the balance, in a sentence. The days of the request are already held. */
function balanceWords(item: LeaveInboxItem): string {
  if (item.unlimited) return item.paid ? `${item.typeName} may go below zero under their policy. Balance now ${dayCount(item.balance.balance)}; after approval ${dayCount(item.balance.balance - item.days)}.` : 'Unpaid leave: no balance is needed.';
  const others = item.balance.held - item.days;
  return `Balance now ${dayCount(item.balance.balance)}; after approval ${dayCount(item.balance.balance - item.days)}.${others > 0 ? ` Their other waiting requests hold ${daysInWords(others)} more.` : ''}`;
}

/** One leave request waiting for a decision: who asks, for which days, why, and what it does to their balance. */
function WaitingCard({ item, onDecide }: { item: LeaveInboxItem; onDecide: (approving: boolean) => void }) {
  const { company } = useMe();
  return (
    <section className="card request" aria-label={`${item.employeeName}, ${item.typeName}, ${leaveRange(item)}`}>
      <div className="card-head">
        <div className="person">
          <Avatar name={item.employeeName} size={42} />
          <div className="person-main">
            <b>
              <Link to={`/employees/${item.employeeId}`}>{item.employeeName}</Link>
            </b>
            <span>
              {item.employeeCode} · asked on {shortDate(item.submittedAt, company.timeZone)}
            </span>
          </div>
        </div>
        <LeaveBadge name={item.typeName} tone={item.typeTone} />
      </div>

      <dl className="facts">
        <div>
          <dt>Dates</dt>
          <dd>
            <Link className="link" to={`/employees/${item.employeeId}/attendance?day=${item.startDate}`}>
              {leaveRange(item)}
            </Link>
          </dd>
        </div>
        <div>
          <dt>Uses</dt>
          <dd>
            {daysInWords(item.days)}
            {item.charged.length > 1 && item.charged.length <= 8 ? `: ${item.charged.map(shortDay).join(', ')}` : ''}
          </dd>
        </div>
        <div className="full">
          <dt>Their reason</dt>
          <dd className="quote">{item.reason}</dd>
        </div>
        <div className="full">
          <dt>Their balance</dt>
          <dd>{balanceWords(item)}</dd>
        </div>
      </dl>

      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={() => onDecide(false)}>
          Reject
        </button>
        <button type="button" className="btn" onClick={() => onDecide(true)}>
          Approve
        </button>
      </div>
    </section>
  );
}

function DecidedTable({ items, onCancel }: { items: LeaveRow[]; onCancel: (row: LeaveRow) => void }) {
  const { company } = useMe();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Who</th>
            <th scope="col">Leave</th>
            <th scope="col">Decision</th>
            <th scope="col">Comment</th>
            <th scope="col" className="cell-end">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <Link to={`/employees/${item.employeeId}`}>{item.employeeName}</Link>
                <span className="cell-sub">{item.employeeCode}</span>
              </td>
              <td>
                {item.typeName} · {daysInWords(item.days)}
                <span className="cell-sub">{leaveRange(item)}</span>
              </td>
              <td>
                <LeaveStatusBadge status={item.status} />
                <span className="cell-sub">
                  {item.status === 'cancelled' && item.decidedBy === item.employeeId ? 'by them' : `by ${item.decidedByName ?? 'someone'}`}
                  {item.decidedAt ? ` · ${shortDate(item.decidedAt, company.timeZone)}` : ''}
                </span>
              </td>
              <td className={item.decisionNote ? undefined : 'cell-none'}>{item.decisionNote || 'None'}</td>
              <td className="cell-end">
                {item.cancel === 'with_reason' && (
                  <button type="button" className="btn ghost sm" onClick={() => onCancel(item)}>
                    Cancel leave
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Leave requests waiting for the signed-in person to decide, and the ones already decided
 * for the people they decide for. Whose those are, is the server's decision on every call.
 */
export function LeavePanel({ view, onChanged }: { view: 'inbox' | 'decided'; onChanged: () => void }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoad<LeaveListPayload>(`/leave/requests${queryOf({ view, page })}`);
  const [deciding, setDeciding] = useState<{ item: LeaveInboxItem; approving: boolean } | null>(null);
  const [cancelling, setCancelling] = useState<LeaveRow | null>(null);

  const refreshAll = () => {
    reload();
    onChanged();
  };

  return (
    <>
      {error && !data ? (
        <section className="card">
          <LoadError message={error} onRetry={reload} />
        </section>
      ) : !data || data.view !== view ? (
        <section className="card">
          <SkeletonLines lines={6} />
        </section>
      ) : data.items.length === 0 ? (
        <section className="card">
          <Empty
            icon={<Inbox size={30} />}
            title={view === 'inbox' ? 'No leave is waiting for you' : 'No leave has been decided yet'}
            body={view === 'inbox' ? 'When someone you decide for asks for leave, it appears here. Your own requests go to someone else.' : 'Leave that was approved, rejected or cancelled is listed here.'}
          />
        </section>
      ) : view === 'inbox' ? (
        <div className="stack">
          {(data.items as LeaveInboxItem[]).map((item) => (
            <WaitingCard key={item.id} item={item} onDecide={(approving) => setDeciding({ item, approving })} />
          ))}
        </div>
      ) : (
        <section className="card">
          <DecidedTable items={data.items} onCancel={setCancelling} />
        </section>
      )}

      {data && <Pager page={data.page} pages={Math.max(1, Math.ceil(data.total / data.pageSize))} total={data.total} pageSize={data.pageSize} onPage={setPage} noun="requests" />}

      {deciding && (
        <DecideDialog
          item={deciding.item}
          approving={deciding.approving}
          onClose={() => setDeciding(null)}
          onDecided={(request) => {
            toast(request.status === 'approved' ? `Approved. ${deciding.item.employeeName} is on leave for those days.` : `Rejected. ${deciding.item.employeeName} will see your reason.`);
            refreshAll();
          }}
          onStale={(message) => {
            toast(message, 'error');
            refreshAll();
          }}
        />
      )}
      {cancelling && (
        <CancelLeaveDialog
          row={cancelling}
          own={false}
          onClose={() => setCancelling(null)}
          onDone={(message, failed) => {
            toast(message, failed ? 'error' : undefined);
            refreshAll();
          }}
        />
      )}
    </>
  );
}
