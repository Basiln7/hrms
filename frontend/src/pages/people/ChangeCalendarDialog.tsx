import { useState } from 'react';
import { addDays, calendarStartBlocker, type AssignmentResult, type CalendarAssignInput, type CalendarListPayload, type Employee, type LocalDate } from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { LoadError, SkeletonLines } from '../../components/states';
import { Modal } from '../../components/ui';
import { api, messageOf } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';

const NONE = 'none';

/** Moves one person to another holiday calendar, or to none, from a date. */
export function ChangeCalendarDialog({ employee, today, currentId, onClose, onDone }: { employee: Pick<Employee, 'id' | 'name'>; today: LocalDate; currentId: string | null; onClose: () => void; onDone: () => void }) {
  const calendars = useLoad<CalendarListPayload>('/holiday-calendars');
  const tomorrow = addDays(today, 1);
  const [calendarId, setCalendarId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState<LocalDate>(tomorrow);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const problems: Record<string, string> = {};
    if (!calendarId) problems.calendarId = 'Choose a calendar.';
    const dateProblem = calendarStartBlocker(effectiveFrom, today);
    if (dateProblem) problems.effectiveFrom = dateProblem;
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      const input: CalendarAssignInput = { calendarId: calendarId === NONE ? null : calendarId, employeeIds: [employee.id], effectiveFrom };
      const answer = await api.post<AssignmentResult>('/holiday-calendars/assign', input);
      // For one person a refusal is simply the reason, shown here so it can be put right.
      if (answer.assigned.length === 0) setFailure(answer.skipped[0]?.reason ?? 'The calendar could not be changed.');
      else {
        onDone();
        onClose();
      }
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const options = (calendars.data?.calendars ?? []).filter((c) => c.id !== currentId);

  return (
    <Modal
      title={`Holiday calendar for ${employee.name}`}
      onClose={onClose}
      width={480}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Change calendar'}
          </button>
        </>
      }
    >
      {calendars.error ? (
        <LoadError message={calendars.error} onRetry={calendars.reload} />
      ) : calendars.loading ? (
        <SkeletonLines lines={3} />
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <FormField label="Calendar" required error={errors.calendarId} hint={options.length === 0 ? <span className="field-hint">There is no other calendar yet. Make one under Holiday calendars.</span> : undefined}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="">Choose a calendar…</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.isDefault ? ' (default)' : ''}
                  </option>
                ))}
                {currentId !== null && <option value={NONE}>No holiday calendar</option>}
              </select>
            )}
          </FormField>
          <FormField label="Starts on" required error={errors.effectiveFrom} hint={<span className="field-hint">Tomorrow at the earliest. Every day before it keeps the calendar they were on then.</span>}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" min={tomorrow} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} required />}
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
