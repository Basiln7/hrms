import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { changeInWords, CORRECTION_INFO, DAY_CHANGED, dayInWords, REASON_MAX, REQUEST_STATUS, type CorrectionInboxItem, type CorrectionListPayload, type CorrectionRequest, type CorrectionRow, type LeaveListPayload } from '@delta-hrms/shared';
import { DayLine } from '../components/attendance';
import { FormField } from '../components/FormField';
import { LoadError, SkeletonLines } from '../components/states';
import { Avatar, Badge, Empty, Modal, Pager, TabPanel, Tabs } from '../components/ui';
import { useAuth, useMe } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api, ApiError, messageOf } from '../lib/api';
import { shortDate } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';
import { LeavePanel } from './approvals/LeavePanel';

const dayTitle = (date: string) => `${dayInWords(date)} ${date.slice(0, 4)}`;

/** Approve or reject one request. A rejection needs its reason; an approval may carry a comment. */
function DecideDialog({ item, approving, onClose, onDecided, onStale }: { item: CorrectionInboxItem; approving: boolean; onClose: () => void; onDecided: (request: CorrectionRequest) => void; onStale: (message: string) => void }) {
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
      // An approval names the version of the day shown here: a day that has changed since is not corrected blind.
      onDecided(approving ? await api.post<CorrectionRequest>(`/regularizations/${item.id}/approve`, { dayVersion: item.dayVersion, note }) : await api.post<CorrectionRequest>(`/regularizations/${item.id}/reject`, { note }));
      onClose();
    } catch (failed) {
      // The day moved on, or someone else decided first: what is on screen is out of date.
      if (failed instanceof ApiError && (failed.code === DAY_CHANGED || failed.status === 409 || failed.status === 404)) {
        onStale(messageOf(failed));
        onClose();
        return;
      }
      setFailure(messageOf(failed));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={approving ? `Approve ${item.employeeName}’s request?` : `Reject ${item.employeeName}’s request?`}
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
        {approving
          ? `${dayTitle(item.date)} is changed as asked: ${changeInWords(item.requested, item.date, item.timeZone).join(', ').toLowerCase()}. What was recorded before stays in the day’s history.`
          : `${dayTitle(item.date)} stays as it is. ${item.employeeName} sees your reason.`}
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

/** One request waiting for a decision: who asks, for which day, what, why, and what the day reads as now and after. */
function WaitingCard({ item, onDecide }: { item: CorrectionInboxItem; onDecide: (approving: boolean) => void }) {
  const { company } = useMe();
  return (
    <section className="card request" aria-label={`${item.employeeName}, ${dayTitle(item.date)}`}>
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
        <Badge color="var(--blue)">{CORRECTION_INFO[item.type].label}</Badge>
      </div>

      <dl className="facts">
        <div>
          <dt>Day</dt>
          <dd>
            <Link className="link" to={`/employees/${item.employeeId}/attendance?day=${item.date}`}>
              {dayTitle(item.date)}
            </Link>
          </dd>
        </div>
        <div>
          <dt>Asks for</dt>
          <dd>{changeInWords(item.requested, item.date, item.timeZone).join(' · ')}</dd>
        </div>
        <div className="full">
          <dt>Their reason</dt>
          <dd className="quote">{item.reason}</dd>
        </div>
        <div>
          <dt>The day now</dt>
          <dd>
            <DayLine day={item.now} timeZone={item.timeZone} />
          </dd>
        </div>
        <div>
          <dt>If approved</dt>
          <dd>{item.after ? <DayLine day={item.after} timeZone={item.timeZone} /> : <span className="field-error">{item.problem}</span>}</dd>
        </div>
      </dl>

      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={() => onDecide(false)}>
          Reject
        </button>
        <button type="button" className="btn" disabled={item.after === null} title={item.after === null ? 'This request no longer fits the day: it can only be rejected.' : undefined} onClick={() => onDecide(true)}>
          Approve
        </button>
      </div>
    </section>
  );
}

function DecidedTable({ items }: { items: CorrectionRow[] }) {
  const { company } = useMe();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Who</th>
            <th scope="col">Day</th>
            <th scope="col">Asked for</th>
            <th scope="col">Decision</th>
            <th scope="col">Comment</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <Link to={`/employees/${item.employeeId}`}>{item.employeeName}</Link>
                <span className="cell-sub">{item.employeeCode}</span>
              </td>
              <td className="nowrap">
                <Link to={`/employees/${item.employeeId}/attendance?day=${item.date}`}>{dayTitle(item.date)}</Link>
              </td>
              <td>
                {CORRECTION_INFO[item.type].label}
                <span className="cell-sub">{changeInWords(item.requested, item.date, item.timeZone).join(' · ')}</span>
              </td>
              <td>
                <Badge color={REQUEST_STATUS[item.status].tone}>{REQUEST_STATUS[item.status].label}</Badge>
                <span className="cell-sub">{item.status === 'cancelled' ? 'by them' : `by ${item.decidedByName ?? 'someone'}`}{item.decidedAt ? ` · ${shortDate(item.decidedAt, company.timeZone)}` : ''}</span>
              </td>
              <td className={item.decisionNote ? undefined : 'cell-none'}>{item.decisionNote || 'None'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Corrections waiting for the signed-in person to decide, and the ones already decided for
 * the people they decide for. Who that is, is the server's decision on every call.
 */
function CorrectionsPanel({ view, onChanged }: { view: View; onChanged: () => void }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoad<CorrectionListPayload>(`/regularizations${queryOf({ view, page })}`);
  const [deciding, setDeciding] = useState<{ item: CorrectionInboxItem; approving: boolean } | null>(null);

  // The list and the numbers on the tabs and in the menu all come from the server: ask for them again.
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
            title={view === 'inbox' ? 'No correction is waiting for you' : 'No correction has been decided yet'}
            body={view === 'inbox' ? 'When someone you decide for asks for a correction, it appears here. Your own requests go to someone else.' : 'Requests that were approved, rejected or cancelled are listed here.'}
          />
        </section>
      ) : view === 'inbox' ? (
        <div className="stack">
          {(data.items as CorrectionInboxItem[]).map((item) => (
            <WaitingCard key={item.id} item={item} onDecide={(approving) => setDeciding({ item, approving })} />
          ))}
        </div>
      ) : (
        <section className="card">
          <DecidedTable items={data.items} />
        </section>
      )}

      {data && <Pager page={data.page} pages={Math.max(1, Math.ceil(data.total / data.pageSize))} total={data.total} pageSize={data.pageSize} onPage={setPage} noun="requests" />}

      {deciding && (
        <DecideDialog
          item={deciding.item}
          approving={deciding.approving}
          onClose={() => setDeciding(null)}
          onDecided={(request) => {
            toast(request.status === 'approved' ? `Approved. ${deciding.item.employeeName}’s day is corrected.` : `Rejected. ${deciding.item.employeeName} will see your reason.`);
            refreshAll();
          }}
          onStale={(message) => {
            toast(message, 'error');
            refreshAll();
          }}
        />
      )}
    </>
  );
}

type View = 'inbox' | 'decided';
type Kind = 'leave' | 'corrections';

/**
 * Everything waiting for the signed-in person to decide, by kind: leave requests and
 * attendance corrections. The numbers on the tabs are the server's own counts.
 */
export default function Approvals() {
  const { refresh } = useAuth();
  const [view, setView] = useState<View>('inbox');
  const [chosen, setChosen] = useState<Kind | null>(null);
  const leave = useLoad<LeaveListPayload>('/leave/requests?view=inbox');
  const corrections = useLoad<CorrectionListPayload>('/regularizations?view=inbox');
  const waiting: Record<Kind, number | undefined> = { leave: leave.data?.total, corrections: corrections.data?.total };
  // Until a tab is picked, the page opens on the kind that has something waiting.
  const kind: Kind = chosen ?? (waiting.leave === 0 && (waiting.corrections ?? 0) > 0 ? 'corrections' : 'leave');

  const onChanged = () => {
    leave.reload();
    corrections.reload();
    void refresh();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>{kind === 'leave' ? 'Leave people have asked for. The days are held from the moment a request is sent; approving makes them leave in the calendar.' : 'Attendance corrections people have asked for. Approving changes the day; what was recorded before is kept in its history.'}</p>
        </div>
      </div>

      <div className="tabs-row">
        <Tabs
          name="approvals"
          label="Kind of request"
          value={kind}
          onChange={setChosen}
          tabs={[
            { id: 'leave', label: 'Leave', count: waiting.leave || undefined, countOf: 'waiting' },
            { id: 'corrections', label: 'Corrections', count: waiting.corrections || undefined, countOf: 'waiting' },
          ]}
        />
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={view === 'inbox'} onClick={() => setView('inbox')}>
            Waiting
          </button>
          <button type="button" aria-pressed={view === 'decided'} onClick={() => setView('decided')}>
            Decided
          </button>
        </div>
      </div>

      <TabPanel name="approvals" tab={kind}>
        {kind === 'leave' ? <LeavePanel key={view} view={view} onChanged={onChanged} /> : <CorrectionsPanel key={view} view={view} onChanged={onChanged} />}
      </TabPanel>
    </>
  );
}
