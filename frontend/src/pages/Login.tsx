import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Mail } from 'lucide-react';
import type { MetaPayload } from '@delta-hrms/shared';
import { Brand, PasswordInput, ThemeToggle } from '../components/controls';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether anyone exists yet. On a brand-new installation there is nobody to sign in as.
  const [meta, setMeta] = useState<MetaPayload | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<MetaPayload>('/meta', { quiet: true })
      .then((payload) => alive && setMeta(payload))
      .catch(() => alive && setError('The server cannot be reached right now. Check your connection and reload this page.'));
    return () => {
      alive = false;
    };
  }, []);

  if (meta?.setupNeeded) return <Navigate to="/setup" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const message = await login(email, password, remember);
    // On success the sign-in state changes and the router leaves this page.
    if (message) {
      setError(message);
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <ThemeToggle className="icon-btn auth-theme" />
      <main className="auth-card reveal">
        <Brand />
        <h1>Sign in</h1>
        <p>Use your work email and your HRMS password.</p>

        <form className="auth-form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">Email</span>
            <span className="input-icon">
              <Mail size={17} />
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@company.com" required autoFocus />
            </span>
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="Your password" required />
          </label>

          <div className="auth-row">
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Keep me signed in on this device
            </label>
          </div>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <button className="btn block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </main>
    </div>
  );
}
