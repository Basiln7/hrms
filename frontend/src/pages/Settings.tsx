import { useState, type FormEvent } from 'react';
import { Building2 } from 'lucide-react';
import { COMPANY_NAME_MAX, MONTH_NAMES, validateCompany, type CompanySettings } from '@delta-hrms/shared';
import { TimeZoneField } from '../components/controls';
import { FormField } from '../components/FormField';
import { tone } from '../components/ui';
import { useAuth, useMe } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api, formFailure } from '../lib/api';

const same = (a: CompanySettings, b: CompanySettings) => a.name === b.name && a.timeZone === b.timeZone && a.weekStartsOn === b.weekStartsOn && a.leaveYearStartMonth === b.leaveYearStartMonth;

/** Company settings. Admin only: the menu hides it from everyone else and the API refuses them. */
export default function Settings() {
  const { refresh } = useAuth();
  const { company } = useMe();
  const toast = useToast();
  const [form, setForm] = useState<CompanySettings>(company);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cleaned: CompanySettings = { ...form, name: form.name.trim(), timeZone: form.timeZone.trim() };
  const unchanged = same(cleaned, company);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || unchanged) return;
    // The same check the server makes, so mistakes show at once, beside their field.
    const problems = validateCompany(cleaned);
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const saved = await api.patch<CompanySettings>('/settings/company', cleaned);
      setForm(saved);
      await refresh();
      toast('Company settings saved.');
    } catch (error) {
      const failed = formFailure(error, ['name', 'timeZone', 'weekStartsOn', 'leaveYearStartMonth']);
      setErrors(failed.fields);
      setFailure(failed.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>What is true for the whole company. Every change is written to the audit log.</p>
        </div>
      </div>

      <section className="card" style={{ maxWidth: 720 }} aria-labelledby="settings-company">
        <div className="card-head with-icon">
          <span className="card-icon" style={tone('var(--accent-text)')}>
            <Building2 size={19} />
          </span>
          <div>
            <h2 className="card-title" id="settings-company">
              Company
            </h2>
            <p className="card-sub">The name people see, and the calendar the company works to.</p>
          </div>
        </div>

        <form className="form-grid" onSubmit={submit} noValidate>
          <FormField label="Company name" required full error={errors.name}>
            {({ id, describedBy, invalid }) => (
              <input id={id} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} maxLength={COMPANY_NAME_MAX} autoComplete="organization" />
            )}
          </FormField>

          <div className="full">
            <TimeZoneField label="Default time zone" value={form.timeZone} onChange={(timeZone) => setForm({ ...form, timeZone })} error={errors.timeZone} />
          </div>

          <FormField label="Week starts on" required error={errors.weekStartsOn} hint={<span className="field-hint">The first column of calendars.</span>}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={form.weekStartsOn} onChange={(e) => setForm({ ...form, weekStartsOn: e.target.value === 'sunday' ? 'sunday' : 'monday' })} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="monday">Monday</option>
                <option value="sunday">Sunday</option>
              </select>
            )}
          </FormField>

          <FormField label="Leave year starts in" required error={errors.leaveYearStartMonth} hint={<span className="field-hint">Leave allowances will run from the first day of this month.</span>}>
            {({ id, describedBy, invalid }) => (
              <select id={id} className="select" value={form.leaveYearStartMonth} onChange={(e) => setForm({ ...form, leaveYearStartMonth: Number(e.target.value) })} aria-describedby={describedBy} aria-invalid={invalid}>
                {MONTH_NAMES.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <p className="note full">
            The time zone is the default for new work schedules. Each schedule can have its own, for people who work in another country, and a schedule that already exists keeps the zone it was made with.
          </p>

          {failure && (
            <div className="form-error full" role="alert">
              {failure}
            </div>
          )}

          <div className="form-actions full">
            <button type="button" className="btn ghost" onClick={() => { setForm(company); setErrors({}); setFailure(null); }} disabled={busy || unchanged}>
              Discard changes
            </button>
            <button className="btn" disabled={busy || unchanged}>
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
