import { useState } from 'react';
import { addDays, localDateOf, rulesHeadline, startBlocker, tidyRules, validateRules, type AssignmentInput, type AssignmentResult, type LocalDate, type Schedule, type ScheduleRow, type ScheduleRules } from '@delta-hrms/shared';
import { api, fieldsOf, messageOf } from '../lib/api';
import { serverNow } from '../lib/serverClock';
import { useLoad } from '../lib/useLoad';
import { FormField } from './FormField';
import { AssignmentOutcome, PeoplePicker } from './PeoplePicker';
import { RulesEditor, RulesSummary } from './RulesEditor';
import { LoadError, SkeletonLines } from './states';
import { Modal } from './ui';

/** The messages for the rules form, without the "rules." the API puts in front of each path. */
const rulesErrors = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).filter(([key]) => key.startsWith('rules.')).map(([key, message]) => [key.slice(6), message]));

interface ForPerson {
  kind: 'person';
  id: string;
  name: string;
  /** Whether a schedule is already in force for them: a change then starts tomorrow at the earliest. */
  hasSchedule: boolean;
  /** Today's date for them, from the server. */
  today: LocalDate;
  /** Where "rules for this person only" starts: their current rules, or a starting point. */
  seedRules: ScheduleRules;
}

interface ForSchedule {
  kind: 'schedule';
  schedule: Schedule;
  /** People already ticked: the ones on the schedule, after it was edited. */
  preselected?: string[];
}

/** Gives a schedule to a person, or to many people at once, from a date. */
export function AssignDialog({ target, onClose, onDone }: { target: ForPerson | ForSchedule; onClose: () => void; onDone: () => void }) {
  const forPerson = target.kind === 'person';
  const schedules = useLoad<ScheduleRow[]>(forPerson ? '/schedules' : null);

  const today = forPerson ? target.today : localDateOf(serverNow(), target.schedule.rules.timeZone);
  const earliest = forPerson && !target.hasSchedule ? today : addDays(today, 1);

  const [custom, setCustom] = useState(false);
  const [scheduleId, setScheduleId] = useState('');
  const [rules, setRules] = useState<ScheduleRules | null>(forPerson ? target.seedRules : null);
  const [effectiveFrom, setEffectiveFrom] = useState<LocalDate>(earliest);
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(forPerson ? [] : (target.preselected ?? [])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssignmentResult | null>(null);

  const available = (schedules.data ?? []).filter((s) => !s.archived);
  const chosen = available.find((s) => s.id === scheduleId) ?? null;

  const submit = async () => {
    if (busy) return;
    const problems: Record<string, string> = {};
    let input: AssignmentInput;
    if (forPerson) {
      const dateProblem = startBlocker(effectiveFrom, target.today, target.hasSchedule);
      if (dateProblem) problems.effectiveFrom = dateProblem;
      if (custom && rules) {
        const tidy = tidyRules(rules);
        Object.assign(problems, validateRules(tidy));
        input = { employeeIds: [target.id], scheduleId: null, rules: tidy, effectiveFrom, note: note.trim() };
      } else {
        if (!scheduleId) problems.scheduleId = 'Choose a schedule.';
        input = { employeeIds: [target.id], scheduleId, rules: null, effectiveFrom, note: note.trim() };
      }
    } else {
      if (selected.size === 0) problems.people = 'Choose at least one person.';
      if (!effectiveFrom || effectiveFrom < today) problems.effectiveFrom = 'Choose a date from today on.';
      input = { employeeIds: [...selected], scheduleId: target.schedule.id, rules: null, effectiveFrom, note: note.trim() };
    }
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const answer = await api.post<AssignmentResult>('/schedule-assignments', input);
      // For one person a refusal is simply the reason, shown here so they can fix the date.
      if (forPerson && answer.assigned.length === 0) setFailure(answer.skipped[0]?.reason ?? 'The schedule could not be given.');
      else if (forPerson) {
        onDone();
        onClose();
      } else setResult(answer);
    } catch (error) {
      const fields = fieldsOf(error);
      const mapped = { ...rulesErrors(fields), ...(fields.scheduleId ? { scheduleId: fields.scheduleId } : {}), ...(fields.effectiveFrom ? { effectiveFrom: fields.effectiveFrom } : {}) };
      setErrors(mapped);
      setFailure(Object.keys(mapped).length > 0 ? 'Some of the rules need another look. Each one is marked.' : messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <AssignmentOutcome
        what="the schedule"
        result={result}
        onClose={() => {
          if (result.assigned.length > 0) onDone();
          onClose();
        }}
      />
    );
  }

  const startField = (
    <FormField
      label="Starts on"
      required
      error={errors.effectiveFrom}
      hint={<span className="field-hint">{forPerson ? (target.hasSchedule ? 'A change starts tomorrow at the earliest: the rules never change under a day that has begun.' : 'A first schedule can start today. Attendance counts from this day.') : 'Someone getting their first schedule can start today. For everyone else a change starts tomorrow at the earliest.'}</span>}
    >
      {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" min={forPerson ? earliest : today} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} required />}
    </FormField>
  );

  const noteField = (
    <FormField label="Note" aside="optional" hint={<span className="field-hint">Kept with the schedule history.</span>}>
      {({ id }) => <input id={id} className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Why the schedule is changing" />}
    </FormField>
  );

  return (
    <Modal
      title={forPerson ? `Schedule for ${target.name}` : `Give “${target.schedule.name}” to people`}
      onClose={onClose}
      width={custom ? 900 : 620}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : forPerson ? 'Give this schedule' : `Give to ${selected.size} ${selected.size === 1 ? 'person' : 'people'}`}
          </button>
        </>
      }
    >
      {forPerson ? (
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="segmented" role="group" aria-label="Kind of schedule">
            <button type="button" aria-pressed={!custom} onClick={() => setCustom(false)}>
              A standard schedule
            </button>
            <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>
              Rules for this person only
            </button>
          </div>

          {!custom && (
            <>
              {schedules.error ? (
                <LoadError message={schedules.error} onRetry={schedules.reload} />
              ) : schedules.loading ? (
                <SkeletonLines lines={2} />
              ) : (
                <FormField label="Schedule" required error={errors.scheduleId} hint={available.length === 0 ? <span className="field-hint">There are no standard schedules yet. Make one under Schedules, or set rules for this person only.</span> : undefined}>
                  {({ id, describedBy, invalid }) => (
                    <select id={id} className="select" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid}>
                      <option value="">Choose a schedule…</option>
                      {available.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({rulesHeadline(s.rules)})
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
              )}
              {chosen && (
                <div className="note">
                  <RulesSummary rules={chosen.rules} />
                </div>
              )}
            </>
          )}

          {custom && rules && (
            <>
              <RulesEditor rules={rules} onChange={setRules} errors={errors} nameLabel="Name of this schedule" />
              <div className="note">
                <RulesSummary rules={rules} />
              </div>
            </>
          )}

          <div className="form-grid">
            {startField}
            {noteField}
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <p className="muted">Each person gets their own copy of the rules as they are now. Changing the schedule later does not change anyone until it is given to them again.</p>
          <PeoplePicker selected={selected} onChange={setSelected} error={errors.people} detail={(p) => p.scheduleName ?? 'No schedule yet'} />
          <div className="form-grid">
            {startField}
            {noteField}
          </div>
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
