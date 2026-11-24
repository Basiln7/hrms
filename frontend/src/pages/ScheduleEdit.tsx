import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, UsersRound } from 'lucide-react';
import { startingRules, tidyRules, validateRules, type Schedule, type ScheduleDetailPayload, type ScheduleRules } from '@delta-hrms/shared';
import { AssignDialog } from '../components/AssignDialog';
import { RulesEditor, RulesSummary } from '../components/RulesEditor';
import { LoadError, SkeletonLines } from '../components/states';
import { Modal } from '../components/ui';
import { useMe } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api, fieldsOf, messageOf } from '../lib/api';
import { dayDate } from '../lib/format';
import { useLoad } from '../lib/useLoad';

/** The API names each problem by its path under "rules."; the form wants the path alone. */
const fromApi = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([key, message]) => [key.replace(/^rules\./, ''), message]));

/** Makes a standard schedule, or changes one. What the rules mean is written out beside the form as they change. */
export default function ScheduleEdit() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { company } = useMe();
  const copyOf = id ? null : params.get('copy');
  // Editing loads the schedule; copying loads the one to copy from; a new one loads nothing.
  const source = useLoad<ScheduleDetailPayload>(id || copyOf ? `/schedules/${id ?? copyOf}` : null);

  const [rules, setRules] = useState<ScheduleRules | null>(id || copyOf ? null : startingRules(company.timeZone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** After a change to a schedule people are on: ask whether to give them the new rules. */
  const [offer, setOffer] = useState<Schedule | null>(null);
  const [applying, setApplying] = useState<Schedule | null>(null);

  useEffect(() => {
    if (!source.data || rules) return;
    setRules(copyOf ? { ...source.data.rules, name: `${source.data.rules.name} (copy)` } : source.data.rules);
  }, [source.data, rules, copyOf]);

  const people = id ? (source.data?.people ?? []) : [];
  const leave = () => navigate('/schedules');

  const save = async () => {
    if (busy || !rules) return;
    const tidy = tidyRules(rules);
    // The same check the server makes, so every problem shows at once, beside its field.
    const problems = validateRules(tidy);
    setErrors(problems);
    setFailure(Object.keys(problems).length > 0 ? 'Some of the rules need another look. Each one is marked.' : null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const saved = id ? await api.patch<Schedule>(`/schedules/${id}`, { rules: tidy }) : await api.post<Schedule>('/schedules', { rules: tidy });
      toast(id ? 'The schedule is saved.' : `${saved.name} is created.`);
      if (id && people.length > 0) setOffer(saved);
      else leave();
    } catch (error) {
      const fields = fromApi(fieldsOf(error));
      setErrors(fields);
      setFailure(Object.keys(fields).length > 0 ? 'Some of the rules need another look. Each one is marked.' : messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <Link className="back" to="/schedules">
      <ArrowLeft size={16} /> Schedules
    </Link>
  );

  if (source.error) {
    return (
      <>
        {back}
        <section className="card">
          <LoadError message={source.error} onRetry={source.reload} />
        </section>
      </>
    );
  }

  return (
    <>
      {back}
      <div className="page-head">
        <div>
          <h1>{id ? (source.data?.name ?? 'Schedule') : copyOf ? 'Copy a schedule' : 'New schedule'}</h1>
          <p>{id ? 'Changing this changes nobody by itself. The people on it keep their copy until you give them the new rules from a date.' : 'Set when people work and how their day is judged. You give it to people afterwards.'}</p>
        </div>
      </div>

      {!rules ? (
        <section className="card">
          <SkeletonLines lines={8} />
        </section>
      ) : (
        <form
          className="split"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <section className="card" aria-label="Rules">
            <RulesEditor rules={rules} onChange={setRules} errors={errors} />
            {failure && (
              <div className="form-error" role="alert" style={{ marginTop: 18 }}>
                {failure}
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={leave} disabled={busy}>
                Cancel
              </button>
              <button className="btn" disabled={busy}>
                {busy ? 'Saving…' : id ? 'Save schedule' : 'Create schedule'}
              </button>
            </div>
          </section>

          <div className="sticky">
            <section className="card" aria-labelledby="plain-words">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="plain-words">
                    In plain words
                  </h2>
                  <p className="card-sub">What these rules mean for someone on this schedule.</p>
                </div>
              </div>
              <RulesSummary rules={rules} />
            </section>

            {id && (
              <section className="card" aria-labelledby="on-it">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="on-it">
                      On it today
                    </h2>
                    <p className="card-sub">{people.length === 0 ? 'Nobody yet.' : `${people.length} ${people.length === 1 ? 'person' : 'people'}, each with their own copy.`}</p>
                  </div>
                </div>
                {people.length > 0 && (
                  <ul className="plain-words">
                    {people.map((p) => (
                      <li key={p.id}>
                        <UsersRound size={16} aria-hidden="true" />
                        <span>
                          <Link className="link" to={`/employees/${p.id}`}>
                            {p.name}
                          </Link>{' '}
                          <span className="cell-none">since {dayDate(p.effectiveFrom)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        </form>
      )}

      {offer && !applying && (
        <Modal
          title="Give the new rules to the people on it?"
          onClose={leave}
          width={500}
          footer={
            <>
              <button type="button" className="btn ghost on-surface" onClick={leave}>
                Not now
              </button>
              <button type="button" className="btn" onClick={() => setApplying(offer)}>
                Choose a date
              </button>
            </>
          }
        >
          <p className="muted">
            {people.length} {people.length === 1 ? 'person is' : 'people are'} on <b>{offer.name}</b>. They are still on the rules as they were: nobody’s schedule changed when you saved. You can give them the new rules from a date you choose, tomorrow at the earliest. Their days up to then stay as they were.
          </p>
        </Modal>
      )}
      {applying && <AssignDialog target={{ kind: 'schedule', schedule: applying, preselected: people.map((p) => p.id) }} onClose={leave} onDone={() => undefined} />}
    </>
  );
}
