import { useState, type FormEvent } from 'react';
import { PASSWORD_MIN } from '@delta-hrms/shared';
import { api, ApiError, formFailure } from '../lib/api';
import { PasswordInput } from './controls';
import { FormField } from './FormField';

interface PasswordFormProps {
  /** What the current password is called here: "Current password", or "Temporary password". */
  currentLabel: string;
  submitLabel: string;
  /** `auth-form` for the full-page version, a plain grid inside a card otherwise. */
  className?: string;
  onChanged: () => void | Promise<void>;
}

/** Changes the signed-in person's own password. Used on the Profile page and when a temporary password must be replaced. */
export function PasswordForm({ currentLabel, submitLabel, className = 'form-grid', onChanged }: PasswordFormProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problems: Record<string, string> = {};
    if (!current) problems.current = 'Enter the password you signed in with.';
    if (next.length < PASSWORD_MIN) problems.next = `Use at least ${PASSWORD_MIN} characters.`;
    else if (next === current) problems.next = 'Choose a password different from the current one.';
    if (again !== next) problems.again = 'The two new passwords are not the same.';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      await api.post('/me/password', { current, next });
      setCurrent('');
      setNext('');
      setAgain('');
      await onChanged();
    } catch (error) {
      const failed = formFailure(error, ['current', 'next']);
      // The server refusing (403) means the current password was wrong: that belongs beside its field.
      // Anything else without a field (the server out of reach, say) is about the whole form.
      if (error instanceof ApiError && error.status === 403 && failed.message) setErrors({ current: failed.message });
      else {
        setErrors(failed.fields);
        setFailure(failed.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={className} onSubmit={submit} noValidate>
      <FormField label={currentLabel} required full error={errors.current}>
        {({ id, describedBy, invalid }) => (
          <PasswordInput id={id} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </FormField>
      <FormField label="New password" required error={errors.next} hint={<span className="field-hint">At least {PASSWORD_MIN} characters.</span>}>
        {({ id, describedBy, invalid }) => (
          <PasswordInput id={id} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </FormField>
      <FormField label="New password, again" required error={errors.again}>
        {({ id, describedBy, invalid }) => (
          <PasswordInput id={id} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </FormField>
      {failure && (
        <div className="form-error full" role="alert">
          {failure}
        </div>
      )}
      <div className="form-actions full">
        <button className={className === 'auth-form' ? 'btn block' : 'btn'} disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
