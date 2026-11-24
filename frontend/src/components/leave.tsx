import { useEffect, useRef, useState } from 'react';
import { CalendarPlus, TreePalm } from 'lucide-react';
import {
  daysInWords,
  approverInWords,
  ENTRY_KIND_LABEL,
  LEAVE_PART_LABEL,
  LEAVE_PARTS,
  LEAVE_TONE_COLOR,
  REASON_MAX,
  REQUEST_STATUS,
  type LeaveAdjustmentInput,
  type LeaveBalanceRow,
  type LeaveBalancesPayload,
  type LeaveListPayload,
  type LeavePart,
  type LeavePreviewPayload,
  type LeaveRequest,
  type LeaveRequestInput,
  type LeaveRow,
  type LeaveTone,
  type LocalDate,
  type PolicyEntry,
  type RequestStatus,
} from '@delta-hrms/shared';
import { api, formFailure, messageOf } from '../lib/api';
import { dayCount, shortDate, shortDay } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { useToast } from '../context/ToastContext';
import { FormField } from './FormField';
import { LoadError, SkeletonLines } from './states';
import { Badge, Empty, Modal, Pager, tone } from './ui';

/*
 * How leave looks, in one place: a kind of leave as a badge, a balance as a card, a request
 * as a row, and the dialogs that ask for leave, cancel it and adjust a balance. Every number
 * shown here was worked out by the API from the account; nothing is counted in the browser.
 */

/** "Tue 8 Dec 2026", "Tue 8 to Thu 10 Dec 2026", "Fri 11 Dec 2026, first half". */
export function leaveRange(request: { startDate: LocalDate; endDate: LocalDate; dayPart: LeavePart }): string {
  const year = request.endDate.slice(0, 4);
  if (request.startDate === request.endDate) return `${shortDay(request.startDate)} ${year}${request.dayPart === 'full' ? '' : `, ${LEAVE_PART_LABEL[request.dayPart].toLowerCase()}`}`;
  return `${shortDay(request.startDate)} to ${shortDay(request.endDate)} ${year}`;
}

/** A kind of leave, in its own colour. */
export function LeaveBadge({ name, tone: toneName }: { name: string; tone: LeaveTone }) {
  return (
    <Badge color={LEAVE_TONE_COLOR[toneName]} dot plain>
      {name}
    </Badge>
  );
}

export function LeaveStatusBadge({ status }: { status: LeaveRequest['status'] }) {
  const look = REQUEST_STATUS[status as RequestStatus] ?? REQUEST_STATUS.pending;
  return <Badge color={look.tone}>{look.label}</Badge>;
}

/** A policy's rules for one kind of leave, in short phrases. Only the rules that restrict something are said. */
export function rulesInWords(entry: PolicyEntry): string[] {
  const words: string[] = [];
  if (entry.maxConsecutiveDays !== null) words.push(`up to ${daysInWords(entry.maxConsecutiveDays)} in a row`);
  if (entry.minNoticeDays > 0) words.push(`asked for ${entry.minNoticeDays} ${entry.minNoticeDays === 1 ? 'day' : 'days'} ahead`);
  else if (entry.backdateDays > 0) words.push(`may start up to ${entry.backdateDays} ${entry.backdateDays === 1 ? 'day' : 'days'} back`);
  if (entry.eligibleAfterDays > 0) words.push(`after ${entry.eligibleAfterDays} days of service`);
  if (entry.carryForwardMax > 0) words.push(`up to ${daysInWords(entry.carryForwardMax)} carried into next year`);
  if (entry.allowNegative) words.push('may go below zero');
  return words;
}

/** One kind of leave after another: what is available, and what that number is made of. */
export function BalanceCards({ rows }: { rows: LeaveBalanceRow[] }) {
  return (
    <ul className="balances">
      {rows.map(({ type, entry, balance }) => {
        const total = balance.granted + balance.carriedForward + balance.adjusted;
        const made: string[] = [];
        if (type.paid) made.push(`${dayCount(balance.granted)} allowance`);
        if (balance.carriedForward !== 0) made.push(`${dayCount(balance.carriedForward)} carried forward`);
        if (balance.adjusted !== 0) made.push(`${balance.adjusted > 0 ? '+' : '−'}${dayCount(Math.abs(balance.adjusted))} adjusted`);
        made.push(`${dayCount(balance.taken)} taken`);
        if (balance.held > 0) made.push(`${dayCount(balance.held)} waiting for approval`);
        const share = (days: number) => `${Math.max(0, Math.min(100, total > 0 ? (days / total) * 100 : 0))}%`;
        return (
          <li key={type.id} style={tone(LEAVE_TONE_COLOR[type.tone])} data-archived={type.archived || undefined}>
            <span className="balance-name">
              <i aria-hidden="true" />
              {type.name}
              <small>{type.code}</small>
            </span>
            {type.paid ? (
              <b className="balance-figure">
                {dayCount(balance.available)}
                <small> {balance.available === 1 ? 'day' : 'days'} available</small>
              </b>
            ) : (
              <b className="balance-figure">
                {dayCount(balance.taken + balance.held)}
                <small> {balance.taken + balance.held === 1 ? 'day' : 'days'} used · no balance needed</small>
              </b>
            )}
            {type.paid && total > 0 && (
              <span className="balance-meter" aria-hidden="true">
                <i style={{ width: share(balance.taken) }} />
                <i data-held="true" style={{ width: share(balance.held) }} />
              </span>
            )}
            <span className="balance-made">{made.join(' · ')}</span>
            {entry === null ? <span className="balance-rule">{type.archived ? 'No longer offered.' : 'Not in the leave policy now: no more can be asked for.'}</span> : rulesInWords(entry).length > 0 && <span className="balance-rule">{rulesInWords(entry).join(' · ')}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Everything added to or taken off an account, oldest first. */
export function EntriesTable({ entries, timeZone }: { entries: LeaveBalancesPayload['entries']; timeZone: string }) {
  if (entries.length === 0) return <p className="muted">Nothing has been added to this account yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What</th>
            <th scope="col">Kind of leave</th>
            <th scope="col" className="cell-end">
              Days
            </th>
            <th scope="col">Note</th>
            <th scope="col">By</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={index}>
              <td className="nowrap">{shortDate(entry.at, timeZone)}</td>
              <td>{ENTRY_KIND_LABEL[entry.kind]}</td>
              <td>{entry.typeName}</td>
              <td className="cell-end num">
                {entry.days > 0 ? '+' : '−'}
                {dayCount(Math.abs(entry.days))}
              </td>
              <td>{entry.note}</td>
              <td className={entry.by ? undefined : 'cell-none'}>{entry.byName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PREVIEW_DELAY_MS = 250;
const noun = (why: 'weekly_off' | 'holiday' | 'not_applicable', name?: string) => (why === 'holiday' ? (name ?? 'holiday') : why === 'weekly_off' ? 'weekly off' : 'not counted');

/**
 * Asks for leave. As soon as the dates are in, the API says how many days the request uses
 * (only this person's working days) and what it leaves, so nothing is sent blind.
 */
export function RequestLeaveDialog({ account, onClose, onSent }: { account: LeaveBalancesPayload; onClose: () => void; onSent: (request: LeaveRequest) => void }) {
  const choices = account.rows.filter((row) => row.entry !== null && !row.type.archived);
  const [form, setForm] = useState<LeaveRequestInput>({ leaveTypeId: choices[0]?.type.id ?? '', startDate: '', endDate: '', dayPart: 'full', reason: '' });
  const [preview, setPreview] = useState<LeavePreviewPayload | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const newest = useRef(0);

  const chosen = choices.find((row) => row.type.id === form.leaveTypeId) ?? null;
  const single = form.startDate !== '' && form.startDate === form.endDate;
  const halfAllowed = single && Boolean(chosen?.type.allowHalfDay);
  const ready = form.leaveTypeId !== '' && form.startDate !== '' && form.endDate !== '';

  const { leaveTypeId, startDate, endDate, dayPart } = form;
  useEffect(() => {
    if (!ready) {
      setPreview(null);
      return;
    }
    const mine = ++newest.current;
    const timer = window.setTimeout(() => {
      api
        .post<LeavePreviewPayload>('/leave/requests/preview', { leaveTypeId, startDate, endDate, dayPart })
        .then((answer) => {
          if (mine === newest.current) setPreview(answer);
        })
        .catch(() => {
          if (mine === newest.current) setPreview(null);
        });
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [ready, leaveTypeId, startDate, endDate, dayPart]);

  const set = (patch: Partial<LeaveRequestInput>) => {
    setForm((before) => {
      const next = { ...before, ...patch };
      // The last day follows the first until it has been set past it.
      if (patch.startDate !== undefined && (next.endDate === '' || next.endDate < next.startDate)) next.endDate = next.startDate;
      const type = choices.find((row) => row.type.id === next.leaveTypeId)?.type;
      if (next.startDate !== next.endDate || !type?.allowHalfDay) next.dayPart = 'full';
      return next;
    });
    setErrors({});
    setFailure(null);
  };

  const submit = async () => {
    if (busy) return;
    const problems: Record<string, string> = {};
    if (!form.leaveTypeId) problems.leaveTypeId = 'Choose a kind of leave.';
    if (!form.startDate) problems.startDate = 'Choose the first day.';
    if (!form.endDate) problems.endDate = 'Choose the last day.';
    if (form.reason.trim().length < 5) problems.reason = 'Say why, in a few words.';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      onSent(await api.post<LeaveRequest>('/leave/requests', form));
      onClose();
    } catch (error) {
      const failed = formFailure(error, ['leaveTypeId', 'startDate', 'endDate', 'dayPart', 'reason']);
      setErrors(failed.fields);
      setFailure(failed.message);
      setBusy(false);
    }
  };

  // While the form is being filled in, the preview's own messages stand beside the fields.
  const shown = { ...(preview?.errors ?? {}), ...errors };
  const sound = preview !== null && Object.keys(preview.errors).length === 0;

  return (
    <Modal
      title="Request leave"
      onClose={onClose}
      width={560}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || choices.length === 0}>
            {busy ? 'Sending…' : sound && preview ? `Send request for ${daysInWords(preview.days)}` : 'Send request'}
          </button>
        </>
      }
    >
      {choices.length === 0 ? (
        <p className="muted">Your leave policy has no kind of leave you can ask for. Ask HR.</p>
      ) : (
        <div className="form-grid">
          <FormField label="Kind of leave" required full error={shown.leaveTypeId} hint={chosen?.entry && rulesInWords(chosen.entry).length > 0 ? <span className="field-hint">{chosen.type.name}: {rulesInWords(chosen.entry).join(', ')}.</span> : undefined}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={form.leaveTypeId} onChange={(e) => set({ leaveTypeId: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid}>
                {choices.map(({ type, balance }) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                    {type.paid ? ` (${dayCount(balance.available)} available)` : ''}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="First day" required error={shown.startDate}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
          <FormField label="Last day" required error={shown.endDate}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => set({ endDate: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
          {halfAllowed && (
            <FormField label="How much of the day" full error={shown.dayPart}>
              {({ id }) => (
                <div className="segmented" role="group" aria-labelledby={id}>
                  <span id={id} className="sr-only">
                    How much of the day
                  </span>
                  {LEAVE_PARTS.map((part) => (
                    <button key={part} type="button" aria-pressed={form.dayPart === part} onClick={() => set({ dayPart: part })}>
                      {LEAVE_PART_LABEL[part]}
                    </button>
                  ))}
                </div>
              )}
            </FormField>
          )}

          {ready && (
            <div className="field full">
              <div className="leave-preview" role="status" data-sound={sound || undefined}>
                {!preview ? (
                  <span className="muted">Counting the days…</span>
                ) : (
                  <>
                    <b>
                      {daysInWords(preview.days)}
                      {chosen ? ` of ${chosen.type.name}` : ''}
                      {preview.yearLabel ? ` · leave year ${preview.yearLabel}` : ''}
                    </b>
                    {preview.charged.length > 0 && <span>Counted: {preview.charged.length > 8 ? `${shortDay(preview.charged[0]!)} to ${shortDay(preview.charged[preview.charged.length - 1]!)}, ${preview.charged.length} working days` : preview.charged.map(shortDay).join(', ')}.</span>}
                    {preview.notCounted.length > 0 && (
                      <span>
                        Not counted: {preview.notCounted.slice(0, 6).map((d) => `${shortDay(d.date)} (${noun(d.why, d.name)})`).join(', ')}
                        {preview.notCounted.length > 6 ? ` and ${preview.notCounted.length - 6} more` : ''}.
                      </span>
                    )}
                    {preview.balance &&
                      (preview.balance.unlimited ? (
                        <span>{chosen?.type.paid ? 'This kind of leave may go below zero.' : 'Unpaid leave needs no balance.'}</span>
                      ) : (
                        <span>
                          Available now: {dayCount(preview.balance.available)}. After this request: <b>{dayCount(preview.balance.after)}</b>.
                        </span>
                      ))}
                  </>
                )}
              </div>
            </div>
          )}

          <FormField label="Reason" required full error={errors.reason} hint={<span className="field-hint">Seen by whoever approves it{account.policy ? `: ${approverInWords(account.policy.approver, 'your')}` : ''}.</span>}>
            {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" value={form.reason} onChange={(e) => set({ reason: e.target.value })} maxLength={REASON_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
        </div>
      )}
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** Cancels a request: one's own, or (HR, with a reason) leave that was already approved. */
export function CancelLeaveDialog({ row, own, onClose, onDone }: { row: LeaveRow; own: boolean; onClose: () => void; onDone: (message: string, failed?: boolean) => void }) {
  const withReason = row.cancel === 'with_reason';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (withReason && !reason.trim()) {
      setError('Say why this leave is cancelled.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/leave/requests/${row.id}/cancel`, withReason ? { reason } : {});
      onDone(row.status === 'approved' ? `The leave is cancelled. ${daysInWords(row.days)} ${row.days === 1 ? 'is' : 'are'} available again.` : 'The request is cancelled.');
    } catch (failure) {
      onDone(messageOf(failure), true);
    }
    onClose();
  };

  const what = `${row.typeName}, ${leaveRange(row)}`;
  return (
    <Modal
      title={row.status === 'approved' ? 'Cancel this leave?' : 'Cancel this request?'}
      onClose={onClose}
      width={460}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Keep it
          </button>
          <button className="btn danger" disabled={busy}>
            {busy ? 'Cancelling…' : row.status === 'approved' ? 'Cancel the leave' : 'Cancel the request'}
          </button>
        </>
      }
    >
      <p className="muted">
        {own
          ? row.status === 'approved'
            ? `Your approved leave (${what}) is cancelled, and its ${daysInWords(row.days)} ${row.days === 1 ? 'goes' : 'go'} back to your balance.`
            : `Your request (${what}) is taken back and nobody decides it. You can ask again afterwards.`
          : `${row.employeeName}’s approved leave (${what}) is cancelled, and its ${daysInWords(row.days)} ${row.days === 1 ? 'goes' : 'go'} back to their balance. Their days then read as they would without it.`}
      </p>
      {withReason && (
        <div style={{ marginTop: 14 }}>
          <FormField label="Reason" required error={error} hint={<span className="field-hint">Kept with the request and in the audit log.</span>}>
            {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
        </div>
      )}
    </Modal>
  );
}

interface RequestListProps {
  /** Which requests: "?view=mine", or "?view=person&employeeId=…". */
  query: string;
  /** Whether these are the signed-in person's own. */
  own: boolean;
  timeZone: string;
  /** Told when a request was cancelled, so balances can be read again. */
  onChanged: () => void;
  empty: { title: string; body: string };
}

/** Leave requests as rows, newest first: what was asked, where it stands, who decided and what they said. */
export function LeaveRequestList({ query, own, timeZone, onChanged, empty }: RequestListProps) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoad<LeaveListPayload>(`/leave/requests${query}&page=${page}`);
  const [cancelling, setCancelling] = useState<LeaveRow | null>(null);

  if (error && !data) return <LoadError message={error} onRetry={reload} />;
  if (!data) return <SkeletonLines lines={3} />;
  if (data.total === 0) return <Empty icon={<TreePalm size={28} />} title={empty.title} body={empty.body} />;

  return (
    <>
      <ul className="request-list">
        {data.items.map((row) => (
          <li key={row.id}>
            <div>
              <b className="leave-line">
                <LeaveBadge name={row.typeName} tone={row.typeTone} />
                <span>{leaveRange(row)}</span>
                <span className="leave-days">{daysInWords(row.days)}</span>
              </b>
              <span>
                “{row.reason}” · asked on {shortDate(row.submittedAt, timeZone)}
              </span>
              {row.status !== 'pending' && (
                <span>
                  {REQUEST_STATUS[row.status as RequestStatus]?.label} by {row.status === 'cancelled' && row.decidedBy === row.employeeId ? (own ? 'you' : 'them') : (row.decidedByName ?? 'someone')}
                  {row.decidedAt ? ` on ${shortDate(row.decidedAt, timeZone)}` : ''}
                  {row.decisionNote ? `: “${row.decisionNote}”` : ''}
                </span>
              )}
            </div>
            <LeaveStatusBadge status={row.status} />
            {row.cancel !== 'no' && (
              <button type="button" className="btn ghost sm" onClick={() => setCancelling(row)}>
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>
      {data.total > data.pageSize && <Pager page={data.page} pages={Math.ceil(data.total / data.pageSize)} total={data.total} pageSize={data.pageSize} onPage={setPage} noun="requests" />}
      {cancelling && (
        <CancelLeaveDialog
          row={cancelling}
          own={own}
          onClose={() => setCancelling(null)}
          onDone={(message, failed) => {
            toast(message, failed ? 'error' : undefined);
            reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** HR adds days to an account or takes days off it, with the reason. */
export function AdjustDialog({ account, onClose, onDone }: { account: LeaveBalancesPayload; onClose: () => void; onDone: () => void }) {
  const rows = account.rows.filter((row) => !row.type.archived);
  const [leaveTypeId, setLeaveTypeId] = useState(rows[0]?.type.id ?? '');
  const [adding, setAdding] = useState(true);
  const [days, setDays] = useState('1');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const row = rows.find((r) => r.type.id === leaveTypeId);
  const amount = Number(days);
  const valid = Number.isFinite(amount) && amount > 0 && Number.isInteger(amount * 2);

  const submit = async () => {
    if (busy) return;
    const problems: Record<string, string> = {};
    if (!leaveTypeId) problems.leaveTypeId = 'Choose a kind of leave.';
    if (!valid) problems.days = 'Give the days in whole or half days: 2, 0.5.';
    if (note.trim().length < 5) problems.note = 'Say why, in a few words.';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      const input: LeaveAdjustmentInput = { employeeId: account.employee.id, leaveYear: account.leaveYear, leaveTypeId, days: adding ? amount : -amount, note };
      await api.post('/leave/adjustments', input);
      onDone();
      onClose();
    } catch (error) {
      const failed = formFailure(error, ['leaveTypeId', 'days', 'note']);
      setErrors(failed.fields);
      setFailure(failed.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Adjust ${account.employee.name}’s leave`}
      onClose={onClose}
      width={500}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : valid ? `${adding ? 'Add' : 'Take off'} ${daysInWords(amount)}` : 'Save'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginBottom: 14 }}>
        For leave year {account.yearLabel}. An adjustment is added to the account with your name and reason; nothing that is already there is changed.
      </p>
      <div className="form-grid">
        <FormField label="Kind of leave" required full error={errors.leaveTypeId} hint={row ? <span className="field-hint">{dayCount(row.balance.available)} available now{row.balance.held > 0 ? `, ${dayCount(row.balance.held)} more held by requests still waiting` : ''}.</span> : undefined}>
          {({ id, describedBy, invalid }) => (
            <select id={id} className="select" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid}>
              {rows.map(({ type }) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Change">
          {({ id }) => (
            <div className="segmented" role="group" aria-labelledby={id}>
              <span id={id} className="sr-only">
                Add or take off
              </span>
              <button type="button" aria-pressed={adding} onClick={() => setAdding(true)}>
                Add days
              </button>
              <button type="button" aria-pressed={!adding} onClick={() => setAdding(false)}>
                Take off
              </button>
            </div>
          )}
        </FormField>
        <FormField label="Days" required error={errors.days}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" type="number" min={0.5} step={0.5} value={days} onChange={(e) => setDays(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField label="Reason" required full error={errors.note}>
          {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={REASON_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
      </div>
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** The button that opens the request form, where there is something to ask for. */
export function RequestLeaveButton({ onClick, small }: { onClick: () => void; small?: boolean }) {
  return (
    <button type="button" className={small ? 'btn sm' : 'btn'} onClick={onClick}>
      <CalendarPlus size={small ? 15 : 17} aria-hidden="true" /> Request leave
    </button>
  );
}
