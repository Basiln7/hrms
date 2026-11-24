import { Brand, ThemeToggle } from '../components/controls';
import { PasswordForm } from '../components/PasswordForm';
import { useAuth, useMe } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

/**
 * Shown instead of the app to someone who signed in with a temporary password from HR. The
 * server lets them do nothing else until they have chosen their own.
 */
export default function ChangePassword() {
  const { refresh, logout } = useAuth();
  const { employee } = useMe();
  const toast = useToast();

  return (
    <div className="auth">
      <ThemeToggle className="icon-btn auth-theme" />
      <main className="auth-card reveal">
        <Brand />
        <h1>Choose your own password</h1>
        <p>
          Welcome, {employee.name}. You signed in with a temporary password. Choose one only you know to go on.
        </p>
        <PasswordForm
          className="auth-form"
          currentLabel="Temporary password"
          submitLabel="Save and continue"
          onChanged={async () => {
            toast('Your password is set.');
            await refresh();
          }}
        />
        <p className="auth-foot">
          Not {employee.name}?{' '}
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </p>
      </main>
    </div>
  );
}
