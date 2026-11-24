import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  addDays,
  CALENDAR_NAME_MAX,
  calendarNameProblem,
  CONFIRM_PAST,
  dayInWords,
  effectInWords,
  HOLIDAY_DESCRIPTION_MAX,
  HOLIDAY_NAME_MAX,
  HOLIDAY_TYPE_INFO,
  HOLIDAY_TYPES,
  localDateOf,
  validateHoliday,
  type AssignmentResult,
  type CalendarAssignInput,
  type CopyYearResult,
  type Holiday,
  type HolidayCalendar,
  type HolidayEffect,
  type HolidayInput,
  type LocalDate,
} from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { AssignmentOutcome, PeoplePicker } from '../../components/PeoplePicker';
import { Modal } from '../../components/ui';
import { useMe } from '../../context/AuthContext';
import { api, ApiError, fieldsOf, messageOf } from '../../lib/api';
import { shortDay } from '../../lib/format';
import { serverNow } from '../../lib/serverClock';

/** The effect the server sent back with a refusal, when it is one. */
const effectOf = (failure: unknown): HolidayEffect | null => (failure instanceof ApiError && failure.code === CONFIRM_PAST ? (failure.details as HolidayEffect) : null);

/** What changing the past would do, as the server worked it out, for HR to read before confirming. */
function PastEffect({ effect }: { effect: HolidayEffect }) {
  return (
    <div className="note warn" role="alert" style={{ marginTop: 14 }}>
      <TriangleAlert size={16} aria-hidden="true" />
      <div className="effect-lines">
        {effectInWords(effect).map((line, index) => (
          <p key={index}>{line}</p>
        ))}
        <p>{effect.changes.length > 0 ? 'Hours already worked stay recorded. ' : ''}The change is written to the audit log.</p>
      </div>
    </div>
  );
}

/** Names a new calendar, or renames one. */
export function CalendarNameDialog({ calendar, onClose, onSaved }: { calendar?: HolidayCalendar; onClose: () => void; onSaved: (saved: HolidayCalendar) => void }) {
  const [name, setName] = useState(calendar?.name ?? '');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const problem = calendarNameProblem(name);
    setError(problem ?? undefined);
    if (problem) return;
    setBusy(true);
    try {
      onSaved(calendar ? await api.patch<HolidayCalendar>(`/holiday-calendars/${calendar.id}`, { name }) : await api.post<HolidayCalendar>('/holiday-calendars', { name }));
      onClose();
    } catch (failure) {
      setError(fieldsOf(failure).name ?? messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={calendar ? 'Rename calendar' : 'New holiday calendar'}
      onClose={onClose}
      width={440}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : calendar ? 'Save name' : 'Create calendar'}
          </button>
        </>
      }
    >
      <FormField label="Name" required error={error} hint={<span className="field-hint">{calendar ? 'Only the name changes. The holidays and the people on it stay as they are.' : 'For example the country or office it is for: “India”, “Dubai office”.'}</span>}>
        {({ id, describedBy, invalid }) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={CALENDAR_NAME_MAX} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" required />}
      </FormField>
    </Modal>
  );
}

/**
 * Adds a holiday to a calendar, or changes one. When the date has already begun for people on
 * the calendar, the server refuses and says what would change; that is shown here, and the
 * save goes through only when it is confirmed.
 */
export function HolidayDialog({ calendarId, holiday, suggestedDate, onClose, onSaved }: { calendarId: string; holiday?: Holiday; suggestedDate: LocalDate; onClose: () => void; onSaved: (saved: Holiday) => void }) {
  const [form, setForm] = useState<HolidayInput>(holiday ? { date: holiday.date, name: holiday.name, type: holiday.type, description: holiday.description } : { date: suggestedDate, name: '', type: 'public', description: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [effect, setEffect] = useState<HolidayEffect | null>(null);
  const [busy, setBusy] = useState(false);

  // Anything typed after the warning means the warning may no longer be the right one: ask again.
  const set = (change: Partial<HolidayInput>) => {
    setForm({ ...form, ...change });
    setEffect(null);
  };

  const submit = async () => {
    if (busy) return;
    const problems = validateHoliday(form);
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    const body = { ...form, ...(effect ? { confirmPast: true } : {}) };
    try {
      onSaved(holiday ? await api.patch<Holiday>(`/holidays/${holiday.id}`, body) : await api.post<Holiday>('/holidays', { calendarId, ...body }));
      onClose();
    } catch (error) {
      const found = effectOf(error);
      if (found) setEffect(found);
      else {
        const fields = fieldsOf(error);
        setErrors(fields);
        setFailure(Object.keys(fields).some((key) => key in form) ? null : messageOf(error));
      }
      setBusy(false);
    }
  };

  return (
    <Modal
      title={holiday ? 'Change holiday' : 'Add holiday'}
      onClose={onClose}
      width={520}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className={effect ? 'btn danger' : 'btn'} disabled={busy}>
            {busy ? 'Saving…' : effect ? (effect.changes.length > 0 ? 'Save and change those days' : 'Save anyway') : holiday ? 'Save changes' : 'Add holiday'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Date" required error={errors.date}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} required />}
        </FormField>
        <FormField label="Kind of day" required error={errors.type}>
          {({ id, describedBy, invalid }) => (
            <select id={id} className="select" value={form.type} onChange={(e) => set({ type: e.target.value as HolidayInput['type'] })} aria-describedby={describedBy} aria-invalid={invalid}>
              {HOLIDAY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {HOLIDAY_TYPE_INFO[type].label}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <p className="field-hint full" style={{ marginTop: -6 }}>
          {HOLIDAY_TYPE_INFO[form.type].hint}
        </p>
        <FormField label="Name" required error={errors.name} full>
          {({ id, describedBy, invalid }) => <input id={id} className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={HOLIDAY_NAME_MAX} placeholder="Onam" aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" required />}
        </FormField>
        <FormField label="Note" aside="optional" error={errors.description} full hint={<span className="field-hint">Shown to everyone on the calendar.</span>}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={HOLIDAY_DESCRIPTION_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
      </div>
      {effect && <PastEffect effect={effect} />}
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** Asks before removing a holiday, and again, with what it changes, when its date has already begun. */
export function RemoveHolidayDialog({ holiday, onClose, onRemoved }: { holiday: Holiday; onClose: () => void; onRemoved: () => void }) {
  const [effect, setEffect] = useState<HolidayEffect | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.delete(`/holidays/${holiday.id}${effect ? '?confirmPast=1' : ''}`);
      onRemoved();
      onClose();
    } catch (error) {
      const found = effectOf(error);
      if (found) setEffect(found);
      else setFailure(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Remove this holiday?"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Removing…' : effect ? (effect.changes.length > 0 ? 'Remove and change those days' : 'Remove anyway') : 'Remove'}
          </button>
        </>
      }
    >
      <p className="muted">
        “{holiday.name}” on {dayInWords(holiday.date)} {holiday.date.slice(0, 4)} will no longer be on this calendar. For the people on it, that date goes back to being whatever their schedule says.
      </p>
      {effect && <PastEffect effect={effect} />}
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** Puts one, several or a whole department on a calendar (or takes it away) from a date. */
export function GiveCalendarDialog({ calendar, onClose, onDone }: { calendar: Pick<HolidayCalendar, 'id' | 'name'>; onClose: () => void; onDone: () => void }) {
  const { company } = useMe();
  const tomorrow = addDays(localDateOf(serverNow(), company.timeZone), 1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [effectiveFrom, setEffectiveFrom] = useState<LocalDate>(tomorrow);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssignmentResult | null>(null);

  const submit = async () => {
    if (busy) return;
    const problems: Record<string, string> = {};
    if (selected.size === 0) problems.people = 'Choose at least one person.';
    if (!effectiveFrom) problems.effectiveFrom = 'Choose the date the calendar starts.';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      const input: CalendarAssignInput = { calendarId: calendar.id, employeeIds: [...selected], effectiveFrom };
      setResult(await api.post<AssignmentResult>('/holiday-calendars/assign', input));
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <AssignmentOutcome
        what="the calendar"
        result={result}
        onClose={() => {
          if (result.assigned.length > 0) onDone();
          onClose();
        }}
      />
    );
  }

  return (
    <Modal
      title={`Give “${calendar.name}” to people`}
      onClose={onClose}
      width={620}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : `Give to ${selected.size} ${selected.size === 1 ? 'person' : 'people'}`}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <p className="muted">From the date below, these people’s holidays come from this calendar. Every day before it keeps the calendar they were on then. To do a whole department, choose it and tick everyone shown.</p>
        <PeoplePicker selected={selected} onChange={setSelected} error={errors.people} detail={(p) => (p.scheduleName ? (p.calendarName ?? 'No calendar') : 'No schedule yet')} />
        <FormField label="Starts on" required error={errors.effectiveFrom} hint={<span className="field-hint">Tomorrow at the earliest, so no day that has begun changes. Someone whose schedule has not started yet gets it from their first day.</span>}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" min={tomorrow} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} required />}
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

/** What copying a year did: what was copied, and for each holiday left out, why. */
export function CopyYearOutcome({ result, onClose }: { result: CopyYearResult; onClose: () => void }) {
  const copied = result.copied.length;
  return (
    <Modal
      title={copied === 0 ? `Nothing was copied to ${result.toYear}` : `${copied} ${copied === 1 ? 'holiday' : 'holidays'} copied to ${result.toYear}`}
      onClose={onClose}
      width={540}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      {copied > 0 && <p className="muted">Each was copied to the same date. Holidays that move from year to year need their date changed by hand: check them below.</p>}
      <ul className="outcome" style={{ marginTop: copied > 0 ? 12 : 0 }}>
        {result.copied.map((h) => (
          <li className="ok" key={h.id}>
            <span>
              <b>{shortDay(h.date)}</b> · {h.name}
            </span>
          </li>
        ))}
        {result.skipped.map((s) => (
          <li className="skipped" key={`${s.date}-${s.name}`}>
            <TriangleAlert size={17} />
            <span>
              <b>{s.name}</b> was left out. {s.reason}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
