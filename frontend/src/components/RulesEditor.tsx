import { useId } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { describeRules, WEEKDAY_NAMES, WEEKDAYS, type BreakMode, type DayHours, type DayRule, type MissingCheckOut, type ScheduleKind, type ScheduleRules, type Weekday } from '@delta-hrms/shared';
import { TimeZoneField } from './controls';
import { FormField } from './FormField';

/** What a set of rules means, in sentences. The same words the API would use: they come from the shared rules. */
export function RulesSummary({ rules }: { rules: ScheduleRules }) {
  return (
    <ul className="plain-words">
      {describeRules(rules).map((line) => (
        <li key={line.text} className={line.warn ? 'warn' : undefined}>
          {line.warn ? <TriangleAlert size={16} aria-label="Check this" /> : <Check size={16} aria-hidden="true" />}
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

const clampInt = (text: string, max: number) => {
  const n = Math.floor(Number(text));
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
};

/** A length of time as hours and minutes. The value is always whole minutes. */
function Duration({ value, onChange, id, describedBy, invalid, maxHours = 24 }: { value: number; onChange: (minutes: number) => void; id?: string; describedBy?: string; invalid?: true; maxHours?: number }) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return (
    <span className="duration">
      <input id={id} className="input" type="number" inputMode="numeric" min={0} max={maxHours} value={hours} onChange={(e) => onChange(clampInt(e.target.value, maxHours) * 60 + minutes)} aria-describedby={describedBy} aria-invalid={invalid} aria-label="Hours" />
      <span>h</span>
      <input className="input" type="number" inputMode="numeric" min={0} max={59} step={5} value={minutes} onChange={(e) => onChange(hours * 60 + clampInt(e.target.value, 59))} aria-invalid={invalid} aria-label="Minutes" />
      <span>min</span>
    </span>
  );
}

function Minutes({ value, onChange, id, describedBy, invalid, max = 240 }: { value: number; onChange: (minutes: number) => void; id?: string; describedBy?: string; invalid?: true; max?: number }) {
  return (
    <span className="duration">
      <input id={id} className="input" type="number" inputMode="numeric" min={0} max={max} value={value} onChange={(e) => onChange(clampInt(e.target.value, max))} aria-describedby={describedBy} aria-invalid={invalid} />
      <span>min</span>
    </span>
  );
}

/** The five fields of one working day: used for the normal day and for a day with hours of its own. */
function HoursFields({ kind, hours, onChange, errors, at }: { kind: ScheduleKind; hours: DayHours; onChange: (hours: DayHours) => void; errors: Record<string, string>; at: string }) {
  const set = <K extends keyof DayHours>(field: K, value: DayHours[K]) => onChange({ ...hours, [field]: value });
  return (
    <div className="form-grid three">
      {kind === 'fixed' && (
        <>
          <FormField label="Starts at" required error={errors[`${at}.start`]}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="time" value={hours.start ?? ''} onChange={(e) => set('start', e.target.value || null)} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
          <FormField label="Ends at" required error={errors[`${at}.end`]} hint={<span className="field-hint">An end before the start means the shift runs past midnight.</span>}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="time" value={hours.end ?? ''} onChange={(e) => set('end', e.target.value || null)} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>
        </>
      )}
      <FormField label="Hours expected" required error={errors[`${at}.requiredMinutes`]}>
        {({ id, describedBy, invalid }) => <Duration id={id} value={hours.requiredMinutes} onChange={(v) => set('requiredMinutes', v)} describedBy={describedBy} invalid={invalid} />}
      </FormField>
      <FormField label="A full day needs" required error={errors[`${at}.fullDayMinutes`]} hint={<span className="field-hint">Of time worked, after the break.</span>}>
        {({ id, describedBy, invalid }) => <Duration id={id} value={hours.fullDayMinutes} onChange={(v) => set('fullDayMinutes', v)} describedBy={describedBy} invalid={invalid} />}
      </FormField>
      <FormField label="Half a day needs" required error={errors[`${at}.halfDayMinutes`]} hint={<span className="field-hint">Less than this does not count as a day.</span>}>
        {({ id, describedBy, invalid }) => <Duration id={id} value={hours.halfDayMinutes} onChange={(v) => set('halfDayMinutes', v)} describedBy={describedBy} invalid={invalid} />}
      </FormField>
    </div>
  );
}

const dayChoice = (rule: DayRule) => (rule === 'off' ? 'off' : rule === 'standard' ? 'standard' : 'own');

interface RulesEditorProps {
  rules: ScheduleRules;
  onChange: (rules: ScheduleRules) => void;
  /** Messages by path into the rules ("standard.start", "days.fri.end"), as `validateRules` gives them. */
  errors: Record<string, string>;
  /** What the name field is called: a standard schedule has a name, a custom one a label. */
  nameLabel?: string;
}

/**
 * The form for a set of schedule rules. It holds no rules of its own: every value it shows
 * is a field of the rules it is given, and every check is the shared `validateRules`.
 */
export function RulesEditor({ rules, onChange, errors, nameLabel = 'Schedule name' }: RulesEditorProps) {
  const fixed = rules.kind === 'fixed';
  const groupId = useId();
  const set = <K extends keyof ScheduleRules>(field: K, value: ScheduleRules[K]) => onChange({ ...rules, [field]: value });

  const setKind = (kind: ScheduleKind) => {
    if (kind === rules.kind) return;
    // Going back to fixed hours needs a start and an end again; offer the usual ones.
    const withTimes = (h: DayHours): DayHours => (kind === 'fixed' ? { ...h, start: h.start ?? '09:00', end: h.end ?? '18:00' } : h);
    const days = Object.fromEntries(WEEKDAYS.map((d) => [d, typeof rules.days[d] === 'object' ? withTimes(rules.days[d] as DayHours) : rules.days[d]])) as Record<Weekday, DayRule>;
    onChange({ ...rules, kind, standard: withTimes(rules.standard), days });
  };

  const setDay = (day: Weekday, choice: string) => {
    const current = rules.days[day];
    const next: DayRule = choice === 'off' ? 'off' : choice === 'standard' ? 'standard' : typeof current === 'object' ? current : { ...rules.standard };
    set('days', { ...rules.days, [day]: next });
  };

  return (
    <div>
      <section className="rules-section">
        <h3>The schedule</h3>
        <p>Fixed hours have a start and an end. Flexible hours only say how long a day is.</p>
        <div className="form-grid">
          <FormField label={nameLabel} required full error={errors.name}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" value={rules.name} onChange={(e) => set('name', e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={80} placeholder="General 9 to 6" />}
          </FormField>
          <div className="field">
            <span className="field-label" id={`${groupId}-kind`}>
              Hours
            </span>
            <div className="segmented" role="group" aria-labelledby={`${groupId}-kind`}>
              <button type="button" aria-pressed={fixed} onClick={() => setKind('fixed')}>
                Fixed hours
              </button>
              <button type="button" aria-pressed={!fixed} onClick={() => setKind('flexible')}>
                Flexible hours
              </button>
            </div>
          </div>
          <TimeZoneField value={rules.timeZone} onChange={(zone) => set('timeZone', zone)} error={errors.timeZone} />
        </div>
      </section>

      <section className="rules-section">
        <h3>A normal working day</h3>
        <p>The hours most working days have. A day can be given hours of its own below.</p>
        <HoursFields kind={rules.kind} hours={rules.standard} onChange={(hours) => set('standard', hours)} errors={errors} at="standard" />
      </section>

      <section className="rules-section">
        <h3>The week</h3>
        <p>Which days are worked, which are the weekly off, and any day that differs.</p>
        {errors.days && (
          <div className="form-error" role="alert" style={{ marginBottom: 12 }}>
            {errors.days}
          </div>
        )}
        <div className="week">
          {WEEKDAYS.map((day) => {
            const rule = rules.days[day];
            const choice = dayChoice(rule);
            return (
              <div className="week-row" key={day}>
                <b id={`${groupId}-${day}`}>{WEEKDAY_NAMES[day]}</b>
                <select className="select" value={choice} onChange={(e) => setDay(day, e.target.value)} aria-labelledby={`${groupId}-${day}`}>
                  <option value="standard">Normal hours</option>
                  <option value="off">Day off</option>
                  <option value="own">Hours of its own</option>
                </select>
                <span className="week-note">{choice === 'off' ? 'Weekly off' : choice === 'standard' ? (fixed ? `${rules.standard.start ?? '--:--'} to ${rules.standard.end ?? '--:--'}` : 'Any hours') : 'Set below'}</span>
                {typeof rule === 'object' && (
                  <div className="week-own">
                    <HoursFields kind={rules.kind} hours={rule} onChange={(hours) => set('days', { ...rules.days, [day]: hours })} errors={errors} at={`days.${day}`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rules-section">
        <h3>Breaks</h3>
        <p>How break time is taken off the time worked.</p>
        <div className="form-grid three">
          <FormField label="Breaks are" required error={errors['break.mode']}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={rules.break.mode} onChange={(e) => set('break', { ...rules.break, mode: e.target.value as BreakMode })} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="fixed">A fixed length, taken off automatically</option>
                <option value="tracked">Recorded with the Break button</option>
                <option value="none">Not taken off</option>
              </select>
            )}
          </FormField>
          {rules.break.mode !== 'none' && (
            <>
              <FormField label={rules.break.mode === 'fixed' ? 'Break length' : 'Take off at least'} required error={errors['break.minutes']} hint={rules.break.mode === 'tracked' ? <span className="field-hint">So never pressing Break gains nothing. 0 for exactly what was recorded.</span> : undefined}>
                {({ id, describedBy, invalid }) => <Minutes id={id} value={rules.break.minutes} onChange={(v) => set('break', { ...rules.break, minutes: v })} describedBy={describedBy} invalid={invalid} max={480} />}
              </FormField>
              <FormField label="Only on days longer than" required error={errors['break.appliesAfter']} hint={<span className="field-hint">The break comes off the time beyond this.</span>}>
                {({ id, describedBy, invalid }) => <Duration id={id} value={rules.break.appliesAfter} onChange={(v) => set('break', { ...rules.break, appliesAfter: v })} describedBy={describedBy} invalid={invalid} />}
              </FormField>
            </>
          )}
        </div>
      </section>

      {fixed && (
        <section className="rules-section">
          <h3>Arriving and leaving</h3>
          <p>What counts as late, how early the day opens, and whether leaving early is marked.</p>
          <div className="form-grid three">
            <FormField label="Late grace" required error={errors.lateGraceMinutes} hint={<span className="field-hint">Arriving this long after the start is still on time.</span>}>
              {({ id, describedBy, invalid }) => <Minutes id={id} value={rules.lateGraceMinutes} onChange={(v) => set('lateGraceMinutes', v)} describedBy={describedBy} invalid={invalid} />}
            </FormField>
            <FormField label="Check-in opens" required error={errors.earlyCheckInMinutes} hint={<span className="field-hint">Before the start time.</span>}>
              {({ id, describedBy, invalid }) => <Duration id={id} value={rules.earlyCheckInMinutes} onChange={(v) => set('earlyCheckInMinutes', v)} describedBy={describedBy} invalid={invalid} maxHours={12} />}
            </FormField>
            <FormField label="Leaving early" required error={errors['earlyLeave.tracked'] ?? errors['earlyLeave.graceMinutes']}>
              {({ id, describedBy, invalid }) => (
                <select id={id} className="select" value={rules.earlyLeave.tracked ? 'yes' : 'no'} onChange={(e) => set('earlyLeave', { ...rules.earlyLeave, tracked: e.target.value === 'yes' })} aria-describedby={describedBy} aria-invalid={invalid}>
                  <option value="yes">Marked as an early departure</option>
                  <option value="no">Not marked</option>
                </select>
              )}
            </FormField>
            {rules.earlyLeave.tracked && (
              <FormField label="Early departure grace" required error={errors['earlyLeave.graceMinutes']} hint={<span className="field-hint">Leaving this long before the end is not marked.</span>}>
                {({ id, describedBy, invalid }) => <Minutes id={id} value={rules.earlyLeave.graceMinutes} onChange={(v) => set('earlyLeave', { ...rules.earlyLeave, graceMinutes: v })} describedBy={describedBy} invalid={invalid} />}
              </FormField>
            )}
          </div>
        </section>
      )}

      <section className="rules-section">
        <h3>When something is missing or unusual</h3>
        <p>A day left without a check-out, work on a day off, and asking for corrections.</p>
        <div className="form-grid three">
          <FormField label="A day can be closed for" required error={errors['missingCheckOut.closeAfterMinutes']} hint={<span className="field-hint">After check-in. Past this the check-out is missing.</span>}>
            {({ id, describedBy, invalid }) => <Duration id={id} value={rules.missingCheckOut.closeAfterMinutes} onChange={(v) => set('missingCheckOut', { ...rules.missingCheckOut, closeAfterMinutes: v })} describedBy={describedBy} invalid={invalid} />}
          </FormField>
          <FormField label="A missing check-out counts as" required error={errors['missingCheckOut.countsAs']}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={rules.missingCheckOut.countsAs} onChange={(e) => set('missingCheckOut', { ...rules.missingCheckOut, countsAs: e.target.value as MissingCheckOut })} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="unresolved">Unresolved until corrected</option>
                <option value="half_day">Half a day</option>
                <option value="absent">Absent</option>
              </select>
            )}
          </FormField>
          <FormField label="Checking in on a day off" required error={errors.offDayWork}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={rules.offDayWork} onChange={(e) => set('offDayWork', e.target.value === 'blocked' ? 'blocked' : 'allowed')} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="allowed">Allowed</option>
                <option value="blocked">Not allowed</option>
              </select>
            )}
          </FormField>
          <FormField label="Corrections can be asked for" required error={errors['corrections.windowDays']} hint={<span className="field-hint">Days back. 0 means employees cannot ask.</span>}>
            {({ id, describedBy, invalid }) => (
              <span className="duration">
                <input id={id} className="input" type="number" inputMode="numeric" min={0} max={90} value={rules.corrections.windowDays} onChange={(e) => set('corrections', { ...rules.corrections, windowDays: clampInt(e.target.value, 90) })} aria-describedby={describedBy} aria-invalid={invalid} />
                <span>days back</span>
              </span>
            )}
          </FormField>
          <FormField label="At most, each month" aside="optional" error={errors['corrections.maxPerMonth']} hint={<span className="field-hint">Leave empty for no limit.</span>}>
            {({ id, describedBy, invalid }) => (
              <span className="duration">
                <input
                  id={id}
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  value={rules.corrections.maxPerMonth ?? ''}
                  onChange={(e) => set('corrections', { ...rules.corrections, maxPerMonth: e.target.value === '' ? null : Math.max(1, clampInt(e.target.value, 31)) })}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
                <span>requests</span>
              </span>
            )}
          </FormField>
        </div>
      </section>
    </div>
  );
}
