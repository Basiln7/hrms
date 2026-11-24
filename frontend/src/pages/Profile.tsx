import { useState, type FormEvent } from 'react';
import { CalendarClock, KeyRound, Monitor, Moon, Palette, Phone, Sun } from 'lucide-react';
import { EMPLOYEE_STATUS, ROLE_INFO, type EmployeeSchedulePayload } from '@delta-hrms/shared';
import { FormField } from '../components/FormField';
import { PasswordForm } from '../components/PasswordForm';
import { RulesSummary } from '../components/RulesEditor';
import { LoadError, SkeletonLines } from '../components/states';
import { Avatar, Badge, tone } from '../components/ui';
import { useAuth, useMe } from '../context/AuthContext';
import { useTheme, type ThemeMode } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import { api, fieldsOf, messageOf } from '../lib/api';
import { dayDate, shortDate } from '../lib/format';
import { useLoad } from '../lib/useLoad';

const THEMES: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
  { mode: 'system', label: 'Same as device', icon: Monitor },
];

function Fact({ label, value, none = 'Not set' }: { label: string; value: string | null | undefined; none?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      {value ? <dd>{value}</dd> : <dd className="none">{none}</dd>}
    </div>
  );
}

function PhoneForm() {
  const { refresh } = useAuth();
  const { employee } = useMe();
  const toast = useToast();
  const [phone, setPhone] = useState(employee.phone);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const unchanged = phone.trim() === employee.phone;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || unchanged) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.patch('/me/profile', { phone: phone.trim() });
      await refresh();
      toast('Your phone number is saved.');
    } catch (failure) {
      setError(fieldsOf(failure).phone ?? messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormField label="Phone number" aside="optional" error={error}>
        {({ id, describedBy, invalid }) => (
          <span className="input-icon">
            <Phone size={17} />
            <input id={id} className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="tel" maxLength={40} placeholder="+91 98470 12345" />
          </span>
        )}
      </FormField>
      <div className="form-actions">
        <button className="btn" disabled={busy || unchanged}>
          {busy ? 'Saving…' : 'Save phone number'}
        </button>
      </div>
    </form>
  );
}

/** The rules the signed-in person's own attendance is judged by, in plain words. */
function MySchedule() {
  const { employee } = useMe();
  const { data, error, reload } = useLoad<EmployeeSchedulePayload>(`/employees/${employee.id}/schedule`);
  if (error) return <LoadError message={error} onRetry={reload} />;
  if (!data) return <SkeletonLines lines={5} />;
  return (
    <>
      {data.current ? (
        <>
          <p className="muted" style={{ marginBottom: 14 }}>
            <b style={{ color: 'var(--text)' }}>{data.current.rules.name}</b>, since {dayDate(data.current.effectiveFrom)}.
          </p>
          <RulesSummary rules={data.current.rules} />
        </>
      ) : (
        <p className="muted">{data.planned.length > 0 ? 'Your schedule has not started yet.' : 'You have not been given a schedule yet. HR sets it.'}</p>
      )}
      {data.planned.map((p) => (
        <div className="planned" key={p.id}>
          <div>
            <b>{p.rules.name}</b>
            <span>Starts {dayDate(p.effectiveFrom)}</span>
          </div>
          <Badge color="var(--blue)">Planned</Badge>
        </div>
      ))}
    </>
  );
}

export default function Profile() {
  const { employee, company } = useMe();
  const { mode, setMode } = useTheme();
  const toast = useToast();
  const status = EMPLOYEE_STATUS[employee.status];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My profile</h1>
          <p>Your details as HR holds them, your password, and how the app looks on this device.</p>
        </div>
      </div>

      <div className="grid">
        <div className="stack col-7">
          <section className="card" aria-labelledby="profile-me">
            <div className="card-head">
              <div className="person">
                <Avatar name={employee.name} size={52} />
                <div className="person-main">
                  <b id="profile-me">{employee.name}</b>
                  <span>{employee.designation || 'No designation set'}</span>
                </div>
              </div>
              <Badge color={ROLE_INFO[employee.role].tone} dot>
                {employee.role}
              </Badge>
            </div>
            <dl className="facts">
              <Fact label="Employee code" value={employee.code} />
              <Fact label="Email" value={employee.email} />
              <Fact label="Department" value={employee.departmentName} none="Not assigned yet" />
              <Fact label="Reports to" value={employee.managerName} none="Nobody" />
              <Fact label="Joined" value={employee.joinDate} none="Not recorded" />
              <div>
                <dt>Account</dt>
                <dd>
                  <Badge color={status.tone}>{status.label}</Badge>
                </dd>
              </div>
              <Fact label="Last signed in" value={employee.lastLoginAt ? shortDate(employee.lastLoginAt, company.timeZone) : null} none="Never" />
              <Fact label="What this role can do" value={ROLE_INFO[employee.role].summary} />
            </dl>
            <p className="note" style={{ marginTop: 16 }}>
              Your name, email, role, department and manager are kept by HR. If one of them is wrong, ask HR to correct it.
            </p>
          </section>

          <section className="card" aria-labelledby="profile-phone">
            <div className="card-head with-icon">
              <span className="card-icon" style={tone('var(--blue)')}>
                <Phone size={19} />
              </span>
              <div>
                <h2 className="card-title" id="profile-phone">
                  Contact number
                </h2>
                <p className="card-sub">The one detail you keep up to date yourself.</p>
              </div>
            </div>
            <PhoneForm />
          </section>

          <section className="card" aria-labelledby="profile-schedule">
            <div className="card-head with-icon">
              <span className="card-icon" style={tone('var(--green)')}>
                <CalendarClock size={19} />
              </span>
              <div>
                <h2 className="card-title" id="profile-schedule">
                  Work schedule
                </h2>
                <p className="card-sub">The rules your attendance is judged by. HR sets them.</p>
              </div>
            </div>
            <MySchedule />
          </section>
        </div>

        <div className="stack col-5">
          <section className="card" aria-labelledby="profile-password">
            <div className="card-head with-icon">
              <span className="card-icon" style={tone('var(--amber)')}>
                <KeyRound size={19} />
              </span>
              <div>
                <h2 className="card-title" id="profile-password">
                  Password
                </h2>
                <p className="card-sub">Changing it signs you out on your other devices.</p>
              </div>
            </div>
            <PasswordForm currentLabel="Current password" submitLabel="Change password" onChanged={() => toast('Your password is changed.')} />
          </section>

          <section className="card" aria-labelledby="profile-theme">
            <div className="card-head with-icon">
              <span className="card-icon" style={tone('var(--violet)')}>
                <Palette size={19} />
              </span>
              <div>
                <h2 className="card-title" id="profile-theme">
                  Appearance
                </h2>
                <p className="card-sub">Remembered on this device only.</p>
              </div>
            </div>
            <div className="theme-options">
              {THEMES.map(({ mode: option, label, icon: Icon }) => (
                <button key={option} type="button" className="theme-option" aria-pressed={mode === option} onClick={() => setMode(option)}>
                  <div className="swatch" data-kind={option} aria-hidden="true">
                    <i />
                    <i />
                  </div>
                  <span>
                    <Icon size={15} /> {label}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
