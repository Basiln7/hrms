import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { localDateOf, openPeriod, type DepartmentRow, type Employee, type LocalDate, type TemporaryPasswordPayload } from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { LoadError, SkeletonLines } from '../../components/states';
import { Modal } from '../../components/ui';
import { useMe } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { api, fieldsOf, messageOf } from '../../lib/api';
import { serverNow } from '../../lib/serverClock';
import { useLoad } from '../../lib/useLoad';

/** Deactivates someone from their last working day, or brings them back from a day. */
export function StatusDialog({ employee, today, onClose, onDone }: { employee: Employee; today: LocalDate; onClose: () => void; onDone: () => void }) {
  const leaving = employee.status !== 'inactive';
  const [date, setDate] = useState<LocalDate>(today);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const open = openPeriod(employee.employment);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`/employees/${employee.id}/status`, leaving ? { status: 'inactive', lastWorkingDay: date } : { status: 'active', from: date });
      onDone();
      onClose();
    } catch (failure) {
      const fields = fieldsOf(failure);
      setError(fields.lastWorkingDay ?? fields.from ?? messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={leaving ? `Deactivate ${employee.name}` : `Reactivate ${employee.name}`}
      onClose={onClose}
      width={460}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className={leaving ? 'btn danger' : 'btn'} disabled={busy}>
            {busy ? 'Saving…' : leaving ? 'Deactivate' : 'Reactivate'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginBottom: 14 }}>
        {leaving
          ? 'They are signed out at once and can no longer sign in. Their records are kept. Attendance stops counting after their last working day.'
          : 'They can sign in again. The time they were away is not counted: no absences are recorded for it.'}
      </p>
      <FormField label={leaving ? 'Last working day' : 'Back from'} required error={error} hint={<span className="field-hint">{leaving ? (open && open.from > today ? 'They have not started yet, so nothing will be counted.' : 'Today at the latest.') : 'Today at the earliest.'}</span>}>
        {({ id, describedBy, invalid }) => (
          <input id={id} className="input" type="date" value={date} max={leaving ? today : undefined} min={leaving ? undefined : today} onChange={(e) => setDate(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} required />
        )}
      </FormField>
    </Modal>
  );
}

/** Asks before giving someone a new temporary password, since it ends their sessions. */
export function ResetPasswordDialog({ employee, onClose, onReset }: { employee: Employee; onClose: () => void; onReset: (result: TemporaryPasswordPayload) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onReset(await api.post<TemporaryPasswordPayload>(`/employees/${employee.id}/reset-password`));
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Reset ${employee.name}’s password`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Resetting…' : 'Reset password'}
          </button>
        </>
      }
    >
      <p className="muted">Their current password stops working and they are signed out everywhere. You get a new temporary password to pass on, and they choose their own when they next sign in.</p>
      {error && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}

/** The company's departments: add, rename, and delete the ones nobody is in. */
export function DepartmentsDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { company } = useMe();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<DepartmentRow[]>('/departments');
  const [name, setName] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Runs one change, then shows the list as the server now has it. */
  const run = async (work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await work();
      toast(done);
      reload();
      onChanged();
    } catch (problem) {
      setFailure(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const wanted = name.trim();
    if (wanted.length < 2) return setFailure('Give the department a name.');
    void run(async () => {
      await api.post('/departments', { name: wanted });
      setName('');
    }, `Added ${wanted}.`);
  };

  const rename = (department: DepartmentRow) => {
    const wanted = (names[department.id] ?? department.name).trim();
    if (wanted === department.name) return;
    if (wanted.length < 2) return setFailure('Give the department a name.');
    void run(async () => {
      await api.patch(`/departments/${department.id}`, { name: wanted });
      setNames(({ [department.id]: _done, ...rest }) => rest);
    }, `Renamed to ${wanted}.`);
  };

  return (
    <Modal
      title="Departments"
      onClose={onClose}
      width={520}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted" style={{ marginBottom: 14 }}>
        The departments of {company.name || 'the company'}. A department can be deleted once nobody is in it.
      </p>
      {error ? (
        <LoadError message={error} onRetry={reload} />
      ) : loading || !data ? (
        <SkeletonLines lines={4} />
      ) : (
        <>
          {data.length === 0 && <p className="note" style={{ marginBottom: 14 }}>No departments yet. Add the first one below.</p>}
          <ul className="rows">
            {data.map((d) => (
              <li key={d.id}>
                <input
                  className="input"
                  value={names[d.id] ?? d.name}
                  onChange={(e) => setNames({ ...names, [d.id]: e.target.value })}
                  onBlur={() => rename(d)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      rename(d);
                    }
                  }}
                  maxLength={60}
                  aria-label={`Name of ${d.name}`}
                />
                <span className="count">
                  {d.peopleCount} {d.peopleCount === 1 ? 'person' : 'people'}
                </span>
                <button
                  type="button"
                  className="icon-btn sm danger"
                  onClick={() => void run(() => api.delete(`/departments/${d.id}`), `Deleted ${d.name}.`)}
                  disabled={busy}
                  aria-label={`Delete ${d.name}`}
                  title={d.peopleCount > 0 ? 'Move its people to another department first' : `Delete ${d.name}`}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
          <div className="rows" style={{ marginBottom: 0 }}>
            <li style={{ listStyle: 'none', display: 'flex', gap: 8 }}>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
                maxLength={60}
                placeholder="New department"
                aria-label="New department name"
              />
              <button type="button" className="btn ghost on-surface" onClick={add} disabled={busy}>
                <Plus size={16} /> Add
              </button>
            </li>
          </div>
        </>
      )}
      {failure && (
        <div className="form-error" role="alert" style={{ marginTop: 14 }}>
          {failure}
        </div>
      )}
    </Modal>
  );
}

/** Today's date in the company's time zone, by the server's clock. */
export const companyToday = (timeZone: string): LocalDate => localDateOf(serverNow(), timeZone);
