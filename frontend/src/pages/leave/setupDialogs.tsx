import { useState } from 'react';
import {
  LEAVE_APPROVER_LABEL,
  LEAVE_NAME_MAX,
  LEAVE_TONE_COLOR,
  LEAVE_TONES,
  POLICY_NAME_MAX,
  startingEntry,
  validateLeavePolicy,
  validateLeaveType,
  type AssignmentResult,
  type LeaveApprover,
  type LeavePolicy,
  type LeavePolicyInput,
  type LeavePolicyRow,
  type LeaveType,
  type LeaveTypeInput,
  type PolicyAssignInput,
  type PolicyEntry,
} from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { PeoplePicker } from '../../components/PeoplePicker';
import { Modal, tone } from '../../components/ui';
import { api, fieldsOf, formFailure, messageOf } from '../../lib/api';

/** Adds a kind of leave, or changes one. */
export function TypeDialog({ type, onClose, onSaved }: { type?: LeaveType; onClose: () => void; onSaved: (saved: LeaveType) => void }) {
  const [form, setForm] = useState<LeaveTypeInput>({ name: type?.name ?? '', code: type?.code ?? '', paid: type?.paid ?? true, allowHalfDay: type?.allowHalfDay ?? true, tone: type?.tone ?? 'blue' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const problems = validateLeaveType(form);
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      onSaved(type ? await api.patch<LeaveType>(`/leave-types/${type.id}`, { ...form, archived: type.archived }) : await api.post<LeaveType>('/leave-types', form));
      onClose();
    } catch (error) {
      const failed = formFailure(error, ['name', 'code', 'paid', 'allowHalfDay', 'tone']);
      setErrors(failed.fields);
      setFailure(failed.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={type ? `Change ${type.name}` : 'Add a kind of leave'}
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
            {busy ? 'Saving…' : type ? 'Save changes' : 'Add'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Name" required error={errors.name}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={LEAVE_NAME_MAX} placeholder="Casual leave" aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField label="Code" required error={errors.code} hint={<span className="field-hint">Short, for tables and exports: CL, SL.</span>}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={6} placeholder="CL" aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField label="Paid or unpaid" required full error={errors.paid} hint={<span className="field-hint">Unpaid leave needs no balance, and is counted apart in the month’s summary. It cannot be changed once this kind has been asked for.</span>}>
          {({ id, describedBy, invalid }) => (
            <select id={id} className="select" value={form.paid ? 'paid' : 'unpaid'} onChange={(e) => setForm({ ...form, paid: e.target.value === 'paid' })} aria-describedby={describedBy} aria-invalid={invalid}>
              <option value="paid">Paid</option>
              <option value="unpaid">Unpaid</option>
            </select>
          )}
        </FormField>
        <div className="field full">
          <label className="check">
            <input type="checkbox" checked={form.allowHalfDay} onChange={(e) => setForm({ ...form, allowHalfDay: e.target.checked })} />
            A half-day can be taken (first half or second half of one date)
          </label>
        </div>
        <div className="field full">
          <span className="field-label" id="leave-tone">
            Colour
          </span>
          <div className="tone-pick" role="radiogroup" aria-labelledby="leave-tone">
            {LEAVE_TONES.map((name) => (
              <button key={name} type="button" role="radio" aria-checked={form.tone === name} aria-label={name} style={tone(LEAVE_TONE_COLOR[name])} onClick={() => setForm({ ...form, tone: name })} />
            ))}
          </div>
          {errors.tone && (
            <span className="field-error" role="alert">
              {errors.tone}
            </span>
          )}
        </div>
      </div>
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** A policy entry while it is being typed: the numbers are still text. */
interface EntryForm {
  on: boolean;
  annualDays: string;
  carryForwardMax: string;
  eligibleAfterDays: string;
  maxConsecutiveDays: string;
  minNoticeDays: string;
  backdateDays: string;
  prorateFirstYear: boolean;
  allowNegative: boolean;
}

const toForm = (entry: PolicyEntry, on: boolean): EntryForm => ({
  on,
  annualDays: String(entry.annualDays),
  carryForwardMax: String(entry.carryForwardMax),
  eligibleAfterDays: String(entry.eligibleAfterDays),
  maxConsecutiveDays: entry.maxConsecutiveDays === null ? '' : String(entry.maxConsecutiveDays),
  minNoticeDays: String(entry.minNoticeDays),
  backdateDays: String(entry.backdateDays),
  prorateFirstYear: entry.prorateFirstYear,
  allowNegative: entry.allowNegative,
});

/** Empty text is not a number: it is sent as NaN and refused with the field's own message. */
const number = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

const fromForm = (leaveTypeId: string, form: EntryForm): PolicyEntry => ({
  leaveTypeId,
  annualDays: number(form.annualDays),
  carryForwardMax: number(form.carryForwardMax),
  eligibleAfterDays: number(form.eligibleAfterDays),
  maxConsecutiveDays: form.maxConsecutiveDays.trim() === '' ? null : Number(form.maxConsecutiveDays),
  minNoticeDays: number(form.minNoticeDays),
  backdateDays: number(form.backdateDays),
  prorateFirstYear: form.prorateFirstYear,
  allowNegative: form.allowNegative,
});

const NUMBER_FIELDS: { field: keyof EntryForm & keyof PolicyEntry; label: string; hint: string; step: number }[] = [
  { field: 'annualDays', label: 'Days a year', hint: 'The allowance for a whole leave year.', step: 0.5 },
  { field: 'carryForwardMax', label: 'Carry forward, up to', hint: 'Unused days taken into the next year. 0: none.', step: 0.5 },
  { field: 'maxConsecutiveDays', label: 'Longest run', hint: 'Working days in a row. Empty: no limit.', step: 0.5 },
  { field: 'minNoticeDays', label: 'Notice', hint: 'Days ahead it must be asked for.', step: 1 },
  { field: 'backdateDays', label: 'May start, days back', hint: 'For leave asked for afterwards. 0: not at all.', step: 1 },
  { field: 'eligibleAfterDays', label: 'After days of service', hint: 'Before that it cannot be taken. 0: from day one.', step: 1 },
];

/** Adds a leave policy, or changes one: who approves, and the rules for each kind of leave in it. */
export function PolicyDialog({ policy, types, onClose, onSaved }: { policy?: LeavePolicy; types: LeaveType[]; onClose: () => void; onSaved: (saved: LeavePolicy) => void }) {
  // Archived kinds are offered only where the policy already has them.
  const offered = types.filter((type) => !type.archived || policy?.entries.some((e) => e.leaveTypeId === type.id));
  const [name, setName] = useState(policy?.name ?? '');
  const [approver, setApprover] = useState<LeaveApprover>(policy?.approver ?? 'manager');
  const [entries, setEntries] = useState<Record<string, EntryForm>>(() =>
    Object.fromEntries(
      offered.map((type) => {
        const existing = policy?.entries.find((e) => e.leaveTypeId === type.id);
        return [type.id, toForm(existing ?? startingEntry(type.id), existing !== undefined)];
      }),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (typeId: string, change: Partial<EntryForm>) => setEntries((before) => ({ ...before, [typeId]: { ...before[typeId]!, ...change } }));

  const submit = async () => {
    if (busy) return;
    const input: LeavePolicyInput = { name, approver, entries: offered.filter((type) => entries[type.id]?.on).map((type) => fromForm(type.id, entries[type.id]!)) };
    const problems = validateLeavePolicy(input, types);
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      onSaved(policy ? await api.patch<LeavePolicy>(`/leave-policies/${policy.id}`, input) : await api.post<LeavePolicy>('/leave-policies', input));
      onClose();
    } catch (error) {
      const fields = fieldsOf(error);
      setErrors(fields);
      setFailure(Object.keys(fields).length > 0 ? null : messageOf(error));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={policy ? `Change the policy “${policy.name}”` : 'Add a leave policy'}
      onClose={onClose}
      width={760}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : policy ? 'Save changes' : 'Add policy'}
          </button>
        </>
      }
    >
      {policy && <p className="note" style={{ marginBottom: 14 }}>A change applies to what is granted and asked for from now on. Allowances already granted this leave year stay as they are: correct a balance with an adjustment.</p>}
      <div className="form-grid">
        <FormField label="Name" required error={errors.name}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={POLICY_NAME_MAX} placeholder="Standard leave" aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField label="Requests are approved by" required error={errors.approver} hint={<span className="field-hint">HR and Admin can always decide. Nobody decides their own request.</span>}>
          {({ id, describedBy, invalid }) => (
            <select id={id} className="select" value={approver} onChange={(e) => setApprover(e.target.value as LeaveApprover)} aria-describedby={describedBy} aria-invalid={invalid}>
              <option value="manager">{LEAVE_APPROVER_LABEL.manager}</option>
              <option value="hr">{LEAVE_APPROVER_LABEL.hr}</option>
            </select>
          )}
        </FormField>
      </div>

      <h3 className="subhead">Kinds of leave in this policy</h3>
      {errors.entries && (
        <span className="field-error" role="alert">
          {errors.entries}
        </span>
      )}
      {offered.length === 0 && <p className="muted">Add a kind of leave first.</p>}
      <div className="policy-entries">
        {offered.map((type) => {
          const form = entries[type.id]!;
          const errorOf = (field: string) => errors[`entries.${type.id}.${field}`];
          return (
            <fieldset key={type.id} className="policy-entry" data-on={form.on} style={tone(LEAVE_TONE_COLOR[type.tone])}>
              <legend>
                <label className="check">
                  <input type="checkbox" checked={form.on} onChange={(e) => patch(type.id, { on: e.target.checked })} />
                  <b>{type.name}</b>
                  <span className="cell-none">
                    {type.code} · {type.paid ? 'paid' : 'unpaid'}
                    {type.archived ? ' · archived' : ''}
                  </span>
                </label>
              </legend>
              {errorOf('leaveTypeId') && (
                <span className="field-error" role="alert">
                  {errorOf('leaveTypeId')}
                </span>
              )}
              {form.on && (
                <>
                  <div className="policy-fields">
                    {NUMBER_FIELDS.map(({ field, label, hint, step }) => (
                      <FormField key={field} label={label} error={errorOf(field)} hint={<span className="field-hint">{hint}</span>}>
                        {({ id, describedBy, invalid }) => <input id={id} className="input" type="number" min={0} step={step} inputMode="decimal" value={form[field] as string} onChange={(e) => patch(type.id, { [field]: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} />}
                      </FormField>
                    ))}
                  </div>
                  <div className="policy-checks">
                    <label className="check">
                      <input type="checkbox" checked={form.prorateFirstYear} onChange={(e) => patch(type.id, { prorateFirstYear: e.target.checked })} />
                      Someone who joins during a leave year gets the share of the months left
                    </label>
                    {type.paid && (
                      <label className="check">
                        <input type="checkbox" checked={form.allowNegative} onChange={(e) => patch(type.id, { allowNegative: e.target.checked })} />
                        More may be taken than is left (the balance may go below zero)
                      </label>
                    )}
                  </div>
                </>
              )}
            </fieldset>
          );
        })}
      </div>
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** Puts one or many people on a policy. Each is judged on their own; the answer says who was moved and who was not. */
export function AssignPolicyDialog({ policy, onClose, onDone }: { policy: LeavePolicyRow; onClose: () => void; onDone: (result: AssignmentResult) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setFailure(null);
    if (selected.size === 0) {
      setError('Choose at least one person.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const input: PolicyAssignInput = { policyId: policy.id, employeeIds: [...selected] };
      onDone(await api.post<AssignmentResult>('/leave-policies/assign', input));
      onClose();
    } catch (failed) {
      setFailure(messageOf(failed));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Put people on “${policy.name}”`}
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
            {busy ? 'Saving…' : selected.size > 0 ? `Put ${selected.size} ${selected.size === 1 ? 'person' : 'people'} on it` : 'Put on this policy'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginBottom: 14 }}>
        Their account for this leave year is opened with the policy’s allowance. Someone moved from another policy keeps what they were already granted.
      </p>
      <PeoplePicker selected={selected} onChange={setSelected} error={error} detail={(person) => person.scheduleName ?? 'No schedule yet'} />
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}
