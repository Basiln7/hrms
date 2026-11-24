import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { isTimeZone, PASSWORD_MIN, type MetaPayload, type SetupInput } from '@delta-hrms/shared';
import { Brand, PasswordInput, ThemeToggle, TimeZoneField } from '../components/controls';
import { FormField } from '../components/FormField';
import { useAuth } from '../context/AuthContext';
import { api, formFailure } from '../lib/api';
import { deviceTimeZone } from '../lib/timeZones';

/** First-run setup: on an installation with nobody in it, creates the company and its first Admin. */
export default function Setup() {
  const { refresh } = useAuth();
  const [meta, setMeta] = useState<MetaPayload | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [form, setForm] = useState<SetupInput>(() => ({ companyName: '', timeZone: deviceTimeZone(), name: '', email: '', password: '', setupCode: '' }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<MetaPayload>('/meta', { quiet: true })
      .then((payload) => alive && setMeta(payload))
      .catch(() => alive && setUnreachable(true));
    return () => {
      alive = false;
    };
  }, []);

  if (meta && !meta.setupNeeded) return <Navigate to="/login" replace />;

  const set = (field: keyof SetupInput) => (value: string) => setForm((f) => ({ ...f, [field]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !meta) return;
    const problems: Record<string, string> = {};
    if (form.companyName.trim().length < 2) problems.companyName = 'Please enter the company name.';
    if (!isTimeZone(form.timeZone.trim())) problems.timeZone = 'Choose a time zone from the list, for example Asia/Kolkata.';
    if (form.name.trim().length < 2) problems.name = 'Please enter your name.';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) problems.email = 'Please enter a valid email address.';
    if (form.password.length < PASSWORD_MIN) problems.password = `Use at least ${PASSWORD_MIN} characters.`;
    if (meta.setupCodeRequired && !form.setupCode?.trim()) problems.setupCode = 'Enter the setup code from the server’s settings.';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const { setupCode, ...rest } = form;
      const body = { ...rest, timeZone: rest.timeZone.trim() };
      await api.post('/setup', meta.setupCodeRequired ? { ...body, setupCode: setupCode?.trim() } : body, { quiet: true });
      // Setup signs the new Admin in; the router then leaves this page.
      await refresh();
    } catch (error) {
      const failed = formFailure(error, ['companyName', 'timeZone', 'name', 'email', 'password', 'setupCode']);
      setErrors(failed.fields);
      setFailure(failed.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <ThemeToggle className="icon-btn auth-theme" />
      <main className="auth-card wide reveal">
        <Brand />
        <h1>Set up your HRMS</h1>

        {unreachable && (
          <div className="form-error" role="alert">
            The server cannot be reached right now. Check that it is running and reload this page.
          </div>
        )}

        {meta && !meta.setupAvailable && (
          <>
            <p>Nobody exists in this HRMS yet, and setup is switched off on this server.</p>
            <p className="auth-note">Whoever runs the server needs to set a setup code (SETUP_CODE in the server’s settings) and restart it. Then reload this page.</p>
          </>
        )}

        {meta?.setupAvailable && (
          <>
            <p>Nobody exists in this HRMS yet. Name the company and create its first Admin. This can be done only once.</p>
            <form className="auth-form" onSubmit={submit} noValidate>
              <div className="auth-section">The company</div>
              <FormField label="Company name" required error={errors.companyName}>
                {({ id, describedBy, invalid }) => (
                  <input id={id} className="input" value={form.companyName} onChange={(e) => set('companyName')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="organization" maxLength={120} autoFocus />
                )}
              </FormField>
              <TimeZoneField value={form.timeZone} onChange={set('timeZone')} error={errors.timeZone} label="Company time zone" />

              <div className="auth-section">You, the first Admin</div>
              <FormField label="Your name" required error={errors.name}>
                {({ id, describedBy, invalid }) => (
                  <input id={id} className="input" value={form.name} onChange={(e) => set('name')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="name" maxLength={80} />
                )}
              </FormField>
              <FormField label="Work email" required error={errors.email}>
                {({ id, describedBy, invalid }) => (
                  <input id={id} className="input" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="username" maxLength={160} />
                )}
              </FormField>
              <FormField label="Password" required error={errors.password} hint={<span className="field-hint">At least {PASSWORD_MIN} characters. You will sign in with this.</span>}>
                {({ id, describedBy, invalid }) => (
                  <PasswordInput id={id} value={form.password} onChange={(e) => set('password')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="new-password" />
                )}
              </FormField>

              {meta.setupCodeRequired && (
                <>
                  <div className="auth-section">Setup code</div>
                  <FormField label="Setup code" required error={errors.setupCode} hint={<span className="field-hint">The value of SETUP_CODE in the server’s settings. It proves you run this server.</span>}>
                    {({ id, describedBy, invalid }) => (
                      <input id={id} className="input" value={form.setupCode} onChange={(e) => set('setupCode')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" spellCheck={false} />
                    )}
                  </FormField>
                </>
              )}

              {failure && (
                <div className="form-error" role="alert">
                  {failure}
                </div>
              )}

              <button className="btn block" disabled={busy}>
                {busy ? 'Setting up…' : 'Create the company and sign in'}
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
