import { useState } from 'react';
import { ANNOUNCEMENT_BODY_MAX, ANNOUNCEMENT_TITLE_MAX, ROLES, validateAnnouncement, type Announcement, type AnnouncementInput, type AnnouncementRow, type DepartmentRow, type Importance, type Role } from '@delta-hrms/shared';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/ui';
import { api, formFailure } from '../../lib/api';
import { serverNow } from '../../lib/serverClock';
import { useLoad } from '../../lib/useLoad';

type AudienceKind = 'all' | 'departments' | 'roles';

const ROLE_WORDS: Record<Role, string> = { Employee: 'Employees', Manager: 'Managers', HR: 'HR', Admin: 'Admins' };

/** Ticks or unticks one value in a list. */
const toggled = <T,>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

/**
 * Writes an announcement, or changes one: what it says, how it stands out, when it shows and
 * who it is for. The two times are on the company's clock, whatever zone this device is in.
 */
export function AnnouncementForm({ announcement, timeZone, onClose, onSaved }: { announcement?: AnnouncementRow; timeZone: string; onClose: () => void; onSaved: (saved: Announcement) => void }) {
  const departments = useLoad<DepartmentRow[]>('/departments');
  const [title, setTitle] = useState(announcement?.title ?? '');
  const [body, setBody] = useState(announcement?.body ?? '');
  const [importance, setImportance] = useState<Importance>(announcement?.importance ?? 'normal');
  const [pinned, setPinned] = useState(announcement?.pinned ?? false);
  // One that exists keeps the start it has unless it is changed; a new one starts now unless a time is given.
  const [startMode, setStartMode] = useState<'now' | 'at'>(announcement ? 'at' : 'now');
  const [startsAt, setStartsAt] = useState(announcement?.startsAtLocal ?? '');
  const [endMode, setEndMode] = useState<'never' | 'at'>(announcement?.expiresAtLocal ? 'at' : 'never');
  const [expiresAt, setExpiresAt] = useState(announcement?.expiresAtLocal ?? '');
  const [kind, setKind] = useState<AudienceKind>(announcement?.audience.kind ?? 'all');
  const [departmentIds, setDepartmentIds] = useState<string[]>(announcement?.audience.kind === 'departments' ? announcement.audience.departmentIds : []);
  const [roles, setRoles] = useState<Role[]>(announcement?.audience.kind === 'roles' ? announcement.audience.roles : []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const input: AnnouncementInput = {
      title,
      body,
      importance,
      pinned,
      // An empty time field is sent as it is, so that it is refused beside the field rather than read as "now".
      startsAt: startMode === 'now' ? null : startsAt,
      expiresAt: endMode === 'never' ? null : expiresAt,
      audience: kind === 'all' ? { kind } : kind === 'departments' ? { kind, departmentIds } : { kind, roles },
    };
    const problems = validateAnnouncement(input, timeZone, serverNow()).errors;
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      onSaved(announcement ? await api.patch<Announcement>(`/announcements/${announcement.id}`, input) : await api.post<Announcement>('/announcements', input));
      onClose();
    } catch (error) {
      const failed = formFailure(error, ['title', 'body', 'importance', 'startsAt', 'expiresAt', 'audience']);
      setErrors(failed.fields);
      setFailure(failed.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={announcement ? 'Change the announcement' : 'New announcement'}
      onClose={onClose}
      width={640}
      onSubmit={() => void submit()}
      ownValidation
      footer={
        <>
          <button type="button" className="btn ghost on-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : announcement ? 'Save changes' : startMode === 'now' ? 'Post now' : 'Schedule'}
          </button>
        </>
      }
    >
      {announcement && <p className="note" style={{ marginBottom: 14 }}>Changing the title or the text shows it as new again to everyone it is for. Changing anything else does not.</p>}
      <div className="form-grid">
        <FormField label="Title" required full error={errors.title}>
          {({ id, describedBy, invalid }) => <input id={id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ANNOUNCEMENT_TITLE_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField label="What it says" required full error={errors.body} hint={<span className="field-hint">Plain text. Line breaks are kept; nothing else is turned into formatting or links.</span>}>
          {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={ANNOUNCEMENT_BODY_MAX} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>

        <FormField label="Importance" error={errors.importance}>
          {({ id }) => (
            <div className="segmented" role="group" aria-labelledby={id}>
              <span id={id} className="sr-only">
                Importance
              </span>
              <button type="button" aria-pressed={importance === 'normal'} onClick={() => setImportance('normal')}>
                Normal
              </button>
              <button type="button" aria-pressed={importance === 'important'} onClick={() => setImportance('important')}>
                Important
              </button>
            </div>
          )}
        </FormField>
        <div className="field">
          <span className="field-label">Position</span>
          <label className="check" style={{ minHeight: 40 }}>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pin to the top of the list while it shows
          </label>
        </div>

        <FormField label="Shows from" error={errors.startsAt} hint={<span className="field-hint">{startMode === 'now' ? 'As soon as it is saved.' : `On ${timeZone} time.`}</span>}>
          {({ id, describedBy, invalid }) => (
            <div className="when">
              <select className="select" aria-label="When it starts" value={startMode} onChange={(e) => setStartMode(e.target.value as 'now' | 'at')}>
                <option value="now">Now</option>
                <option value="at">A date and time</option>
              </select>
              {startMode === 'at' && <input id={id} className="input" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-label="Start date and time" aria-describedby={describedBy} aria-invalid={invalid} />}
            </div>
          )}
        </FormField>
        <FormField label="Shows until" error={errors.expiresAt} hint={<span className="field-hint">{endMode === 'never' ? 'Until it is deleted.' : `On ${timeZone} time.`}</span>}>
          {({ id, describedBy, invalid }) => (
            <div className="when">
              <select className="select" aria-label="When it ends" value={endMode} onChange={(e) => setEndMode(e.target.value as 'never' | 'at')}>
                <option value="never">It is taken down by hand</option>
                <option value="at">A date and time</option>
              </select>
              {endMode === 'at' && <input id={id} className="input" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="End date and time" aria-describedby={describedBy} aria-invalid={invalid} />}
            </div>
          )}
        </FormField>

        <FormField label="Who it is for" required full error={errors.audience} hint={<span className="field-hint">Decided by each person’s department and role as they are when they look, not as they were when this was posted.</span>}>
          {({ id, describedBy, invalid }) => (
            <>
              <select id={id} className="select" value={kind} onChange={(e) => setKind(e.target.value as AudienceKind)} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="all">Everyone</option>
                <option value="departments">Chosen departments</option>
                <option value="roles">Chosen roles</option>
              </select>
              {kind === 'departments' && (
                <div className="choices" role="group" aria-label="Departments">
                  {departments.error ? (
                    <span className="field-error">{departments.error}</span>
                  ) : !departments.data ? (
                    <span className="muted">Loading the departments…</span>
                  ) : departments.data.length === 0 ? (
                    <span className="muted">There are no departments yet.</span>
                  ) : (
                    departments.data.map((department) => (
                      <label className="check" key={department.id}>
                        <input type="checkbox" checked={departmentIds.includes(department.id)} onChange={() => setDepartmentIds(toggled(departmentIds, department.id))} />
                        {department.name}
                      </label>
                    ))
                  )}
                </div>
              )}
              {kind === 'roles' && (
                <div className="choices" role="group" aria-label="Roles">
                  {ROLES.map((role) => (
                    <label className="check" key={role}>
                      <input type="checkbox" checked={roles.includes(role)} onChange={() => setRoles(toggled(roles, role))} />
                      {ROLE_WORDS[role]}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
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
