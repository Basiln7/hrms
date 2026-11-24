import { useState } from 'react';
import {
  addDays,
  canBeManager,
  grantableRoles,
  localDateOf,
  ROLE_INFO,
  rulesHeadline,
  type DepartmentRow,
  type Employee,
  type EmployeeInput,
  type LocalDate,
  type NewEmployeeInput,
  type PersonOption,
  type Role,
  type ScheduleRow,
  type TemporaryPasswordPayload,
} from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { LoadError, SkeletonLines } from '../../components/states';
import { Modal } from '../../components/ui';
import { useAuth, useMe } from '../../context/AuthContext';
import { api, formFailure } from '../../lib/api';
import { serverNow } from '../../lib/serverClock';
import { useLoad } from '../../lib/useLoad';

const FIELDS = ['name', 'email', 'phone', 'role', 'departmentId', 'designation', 'managerId', 'joinDate', 'schedule.scheduleId', 'schedule.effectiveFrom'];

interface EmployeeFormProps {
  /** The person being changed, or null to add someone. */
  employee: Employee | null;
  onClose: () => void;
  /** Called with the new person and their one-time password after adding, or with nothing after a change. */
  onSaved: (created?: TemporaryPasswordPayload) => void;
}

/** Adds a person, or changes one. The server makes their code and their temporary password. */
export function EmployeeForm({ employee, onClose, onSaved }: EmployeeFormProps) {
  const { can } = useAuth();
  const { employee: me, company } = useMe();
  const adding = employee === null;
  const departments = useLoad<DepartmentRow[]>('/departments');
  const people = useLoad<PersonOption[]>('/employees/picker');
  const schedules = useLoad<ScheduleRow[]>(adding && can('schedules.manage') ? '/schedules' : null);

  const tomorrow = addDays(localDateOf(serverNow(), company.timeZone), 1);
  const [form, setForm] = useState<EmployeeInput>(() => ({
    name: employee?.name ?? '',
    email: employee?.email ?? '',
    phone: employee?.phone ?? '',
    role: employee?.role ?? 'Employee',
    departmentId: employee?.departmentId ?? null,
    designation: employee?.designation ?? '',
    managerId: employee?.managerId ?? null,
    joinDate: employee?.joinDate ?? null,
  }));
  const [scheduleId, setScheduleId] = useState('');
  const [startsOn, setStartsOn] = useState<LocalDate>(tomorrow);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof EmployeeInput>(field: K, value: EmployeeInput[K]) => setForm((f) => ({ ...f, [field]: value }));

  // The roles this person may give. Someone's current role stays in the list so the form can show it.
  const grantable = grantableRoles(me.role);
  const roles = [...new Set<Role>([...(employee ? [employee.role] : []), ...grantable])];
  const managers = (people.data ?? []).filter((p) => canBeManager(p.role) && p.id !== employee?.id);
  const usable = (schedules.data ?? []).filter((s) => !s.archived);
  const chosen = usable.find((s) => s.id === scheduleId);

  const submit = async () => {
    if (busy) return;
    const cleaned: EmployeeInput = { ...form, name: form.name.trim(), email: form.email.trim().toLowerCase(), phone: form.phone.trim(), designation: form.designation.trim() };
    const problems: Record<string, string> = {};
    if (cleaned.name.length < 2) problems.name = 'Please enter their name.';
    if (!/^\S+@\S+\.\S+$/.test(cleaned.email)) problems.email = 'Please enter a valid email address.';
    if (adding && scheduleId && !startsOn) problems['schedule.effectiveFrom'] = 'Choose the date the schedule starts.';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      if (adding) {
        const body: NewEmployeeInput = { ...cleaned, schedule: scheduleId ? { scheduleId, effectiveFrom: startsOn } : null };
        onSaved(await api.post<TemporaryPasswordPayload>('/employees', body));
      } else {
        await api.patch(`/employees/${employee.id}`, cleaned);
        onSaved();
      }
      onClose();
    } catch (error) {
      const failed = formFailure(error, FIELDS);
      setErrors(failed.fields);
      setFailure(failed.message);
      setBusy(false);
    }
  };

  const loading = departments.loading || people.loading || schedules.loading;
  const loadError = departments.error ?? people.error ?? schedules.error;

  return (
    <Modal
      title={adding ? 'Add an employee' : `Change ${employee.name}`}
      onClose={onClose}
      width={640}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || loading || Boolean(loadError)}>
            {busy ? 'Saving…' : adding ? 'Add employee' : 'Save changes'}
          </button>
        </>
      }
    >
      {loadError ? (
        <LoadError
          message={loadError}
          onRetry={() => {
            departments.reload();
            people.reload();
            schedules.reload();
          }}
        />
      ) : loading ? (
        <SkeletonLines lines={6} />
      ) : (
        <div className="form-grid">
          <FormField label="Full name" required error={errors.name}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" value={form.name} onChange={(e) => set('name', e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={80} autoComplete="off" />}
          </FormField>
          <FormField label="Work email" required error={errors.email} hint={<span className="field-hint">They sign in with this.</span>}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={160} autoComplete="off" />}
          </FormField>
          <FormField label="Designation" aside="optional" error={errors.designation}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" value={form.designation} onChange={(e) => set('designation', e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={80} placeholder="Sales Executive" />}
          </FormField>
          <FormField label="Phone" aside="optional" error={errors.phone}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={40} />}
          </FormField>
          <FormField label="Role" required error={errors.role} hint={<span className="field-hint">{ROLE_INFO[form.role].summary}</span>}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={form.role} onChange={(e) => set('role', e.target.value as Role)} aria-describedby={describedBy} aria-invalid={invalid}>
                {roles.map((role) => (
                  <option key={role} value={role} disabled={!grantable.includes(role)}>
                    {role}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Department" aside="optional" error={errors.departmentId}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={form.departmentId ?? ''} onChange={(e) => set('departmentId', e.target.value || null)} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="">No department</option>
                {(departments.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Reports to" aside="optional" error={errors.managerId} hint={<span className="field-hint">A Manager, HR or Admin. Their manager sees their records and decides their requests.</span>}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={form.managerId ?? ''} onChange={(e) => set('managerId', e.target.value || null)} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="">Nobody</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Joined the company" aside="optional" error={errors.joinDate} hint={<span className="field-hint">For the record. Attendance counts from their first schedule, not from this date.</span>}>
            {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" value={form.joinDate ?? ''} onChange={(e) => set('joinDate', e.target.value || null)} aria-describedby={describedBy} aria-invalid={invalid} />}
          </FormField>

          {adding && can('schedules.manage') && (
            <>
              <FormField label="Work schedule" aside="optional" error={errors['schedule.scheduleId']} hint={<span className="field-hint">{chosen ? rulesHeadline(chosen.rules) : 'Without one they cannot check in. It can be given later from their page.'}</span>}>
                {({ id, describedBy, invalid }) => (
                  <select id={id} className="select" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid}>
                    <option value="">No schedule yet</option>
                    {usable.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              {scheduleId && (
                <FormField label="Schedule starts on" required error={errors['schedule.effectiveFrom']} hint={<span className="field-hint">Today at the earliest. Attendance counts from this day.</span>}>
                  {({ id, describedBy, invalid }) => <input id={id} className="input" type="date" min={addDays(tomorrow, -1)} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
                </FormField>
              )}
            </>
          )}

          {adding && <p className="note full">Their employee code and a temporary password are made when you add them. The password is shown once, for you to pass on.</p>}
          {failure && (
            <div className="form-error full" role="alert">
              {failure}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
