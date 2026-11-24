import { useState } from 'react';
import {
  CORRECTION_INFO,
  DAY_CHANGED,
  DAY_NOTE_MAX,
  dayInWords,
  REASON_MAX,
  toLocalDateTime,
  type CorrectionInput,
  type CorrectionRequest,
  type CorrectionType,
  type DayDetailPayload,
  type DirectCorrectionInput,
  type LocalDate,
} from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/ui';
import { api, ApiError, fieldsOf, messageOf } from '../../lib/api';

const dayTitle = (date: LocalDate) => `${dayInWords(date)} ${date.slice(0, 4)}`;

/** A recorded moment as a date-and-time field holds it, in the day's own time zone. Empty when there is none. */
const fieldValue = (moment: string | null | undefined, zone: string) => (moment ? toLocalDateTime(moment, zone) : '');

/**
 * Asks for a correction of one's own day. Only the kinds that fit the day are offered, and
 * each asks for just what it needs. The server checks everything again with the same rules,
 * and its message lands beside the field it is about.
 */
export function CorrectionDialog({ date, detail, onClose, onSent }: { date: LocalDate; detail: DayDetailPayload; onClose: () => void; onSent: (request: CorrectionRequest) => void }) {
  const zone = detail.timeZone ?? 'UTC';
  const types = detail.requestable?.types ?? [];
  const { day } = detail;
  const [type, setType] = useState<CorrectionType>(types[0] ?? 'forgot_attendance');
  // Start from what is recorded; where nothing is, from the shift's own times.
  const [checkIn, setCheckIn] = useState(fieldValue(day.checkInAt ?? day.shiftStartAt, zone));
  const [checkOut, setCheckOut] = useState(fieldValue(day.checkOutAt ?? day.shiftEndAt, zone));
  const [status, setStatus] = useState<'present' | 'half_day'>('present');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { asks, hint } = CORRECTION_INFO[type];

  const submit = async () => {
    if (busy) return;
    const problems: Record<string, string> = {};
    if (asks.checkIn && !checkIn) problems.checkIn = 'Give the check-in time.';
    if (asks.checkOut && !checkOut) problems.checkOut = 'Give the check-out time.';
    if (!reason.trim()) problems.reason = 'Say why, in a few words.';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    const input: CorrectionInput = {
      date,
      type,
      checkIn: asks.checkIn ? checkIn : null,
      checkOut: asks.checkOut ? checkOut : null,
      // A half-day can only be corrected to a full day.
      status: asks.status ? (type === 'half_day_correction' ? 'present' : status) : null,
      reason,
    };
    try {
      onSent(await api.post<CorrectionRequest>('/regularizations', input));
      onClose();
    } catch (failed) {
      const fields = fieldsOf(failed);
      setErrors(fields);
      setFailure(['type', 'checkIn', 'checkOut', 'status', 'reason'].some((name) => fields[name]) && !fields.type ? null : (fields.type ?? messageOf(failed)));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Ask for a correction: ${dayTitle(date)}`}
      onClose={onClose}
      width={540}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="What needs correcting" required full hint={<span className="field-hint">{hint}</span>}>
          {({ id }) => (
            <select id={id} className="select" value={type} onChange={(e) => setType(e.target.value as CorrectionType)}>
              {types.map((option) => (
                <option key={option} value={option}>
                  {CORRECTION_INFO[option].label}
                </option>
              ))}
            </select>
          )}
        </FormField>

        {asks.checkIn && (
          <FormField label="Check-in should be" required error={errors.checkIn} full={!asks.checkOut}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
        )}
        {asks.checkOut && (
          <FormField label="Check-out should be" required error={errors.checkOut} full={!asks.checkIn}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="datetime-local" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
        )}
        {asks.status && type === 'absent_correction' && (
          <FormField label="The day should count as" required error={errors.status} full>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={status} onChange={(e) => setStatus(e.target.value as 'present' | 'half_day')} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="present">Present, a full day</option>
                <option value="half_day">A half-day</option>
              </select>
            )}
          </FormField>
        )}
        {(asks.checkIn || asks.checkOut) && <p className="field-hint full">Times are on the clock of your schedule ({zone}). Whoever decides sees what was recorded and what you ask for, side by side.</p>}

        <FormField label="Reason" required error={errors.reason} full hint={<span className="field-hint">Your manager or HR reads this to decide.</span>}>
          {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
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

/**
 * HR corrects someone's day directly: the facts as they should be, and why. The server keeps
 * what was there before in the day's history, and refuses if the day has changed since this
 * dialog was opened.
 */
export function DirectCorrectionDialog({ employeeId, date, detail, onClose, onDone, onStale }: { employeeId: string; date: LocalDate; detail: DayDetailPayload; onClose: () => void; onDone: () => void; onStale: (message: string) => void }) {
  const zone = detail.timeZone ?? 'UTC';
  const record = detail.record;
  const [checkIn, setCheckIn] = useState(fieldValue(record?.checkInAt, zone));
  const [checkOut, setCheckOut] = useState(fieldValue(record?.checkOutAt, zone));
  const [override, setOverride] = useState<'' | 'present' | 'half_day'>(record?.override ?? '');
  const [lateExcused, setLateExcused] = useState(record?.lateExcused ?? false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = detail.day.kind === 'working';

  const submit = async () => {
    if (busy) return;
    if (!reason.trim()) {
      setErrors({ reason: 'Say why, in a few words.' });
      return;
    }
    setBusy(true);
    setErrors({});
    setFailure(null);
    const input: DirectCorrectionInput = { checkIn: checkIn || null, checkOut: checkOut || null, override: override || null, lateExcused, reason, dayVersion: detail.version };
    try {
      await api.post(`/attendance/days/${employeeId}/${date}/correct`, input);
      onDone();
      onClose();
    } catch (failed) {
      if (failed instanceof ApiError && failed.code === DAY_CHANGED) {
        onStale(messageOf(failed));
        onClose();
        return;
      }
      const fields = fieldsOf(failed);
      setErrors(fields);
      setFailure(['checkIn', 'checkOut', 'override', 'lateExcused', 'reason'].some((name) => fields[name]) ? null : messageOf(failed));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Correct ${dayTitle(date)}`}
      onClose={onClose}
      width={540}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginBottom: 14 }}>
        Set the day as it should be. What is recorded now stays in the day’s history, with your name and reason. Empty both times to take a mistaken punch away.
      </p>
      <div className="form-grid">
        <FormField label="Check-in" error={errors.checkIn}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField label="Check-out" error={errors.checkOut}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" type="datetime-local" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField label="The day counts as" error={errors.override} full hint={<span className="field-hint">{working ? 'Leave this as the hours say unless the hours do not tell the whole day.' : 'A day off is not counted as present or half-day.'}</span>}>
          {({ id, describedBy, invalid }) => (
            <select id={id} className="select" value={override} onChange={(e) => setOverride(e.target.value as '' | 'present' | 'half_day')} disabled={!working} aria-describedby={describedBy} aria-invalid={invalid}>
              <option value="">As the hours say</option>
              <option value="present">Present, a full day</option>
              <option value="half_day">A half-day</option>
            </select>
          )}
        </FormField>
        <div className="field full">
          <label className="check">
            <input type="checkbox" checked={lateExcused} onChange={(e) => setLateExcused(e.target.checked)} />
            The late entry is excused
          </label>
          {errors.lateExcused ? (
            <span className="field-error" role="alert">
              {errors.lateExcused}
            </span>
          ) : (
            <span className="field-hint">The day still shows as late, marked as excused. Only for a day that is a late entry.</span>
          )}
        </div>
        <FormField label="Reason" required error={errors.reason} full hint={<span className="field-hint">Kept with the change, and shown to the person.</span>}>
          {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <p className="field-hint full">Times are on the clock of their schedule ({zone}).</p>
      </div>
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** HR leaves a note on someone's day, changes it, or removes it. The person and their managers see it. */
export function NoteDialog({ employeeId, date, current, onClose, onDone }: { employeeId: string; date: LocalDate; current: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(current);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const save = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.put(`/attendance/days/${employeeId}/${date}/note`, { text: value });
      onDone();
      onClose();
    } catch (failed) {
      setError(fieldsOf(failed).text ?? messageOf(failed));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Note on ${dayTitle(date)}`}
      onClose={onClose}
      width={480}
      onSubmit={() => void save(text)}
      ownValidation
      footer={
        <>
          {current && (
            <button type="button" className="btn danger" disabled={busy} onClick={() => void save('')}>
              Remove note
            </button>
          )}
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Save note'}
          </button>
        </>
      }
    >
      <FormField label="Note" error={error} hint={<span className="field-hint">Shown to the person and their managers on this day. It changes nothing about how the day counts.</span>}>
        {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={DAY_NOTE_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
      </FormField>
    </Modal>
  );
}
