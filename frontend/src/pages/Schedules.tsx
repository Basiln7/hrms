import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, CalendarClock, Copy, Pencil, Plus, UserPlus } from 'lucide-react';
import { rulesHeadline, type ScheduleRow } from '@delta-hrms/shared';
import { AssignDialog } from '../components/AssignDialog';
import { LoadError, SkeletonLines } from '../components/states';
import { Badge, Empty } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { api, messageOf } from '../lib/api';
import { useLoad } from '../lib/useLoad';

/** The company's standard schedules: named sets of rules that can be given to many people. */
export default function Schedules() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<ScheduleRow[]>('/schedules');
  const [showArchived, setShowArchived] = useState(false);
  const [giving, setGiving] = useState<ScheduleRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const archived = (data ?? []).filter((s) => s.archived).length;
  const shown = (data ?? []).filter((s) => showArchived || !s.archived);

  const setArchived = async (schedule: ScheduleRow, value: boolean) => {
    if (busy) return;
    setBusy(schedule.id);
    try {
      await api.post(`/schedules/${schedule.id}/archive`, { archived: value });
      toast(value ? `${schedule.name} is archived.` : `${schedule.name} is restored.`);
      reload();
    } catch (failure) {
      toast(messageOf(failure), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Schedules</h1>
          <p>Standard schedules to give to people. Each person keeps the copy they were given, so changing one here changes nobody until it is given again.</p>
        </div>
        <div className="head-actions">
          {archived > 0 && (
            <button type="button" className="btn ghost" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Hide archived' : `Show archived (${archived})`}
            </button>
          )}
          <Link className="btn" to="/schedules/new">
            <Plus size={17} /> New schedule
          </Link>
        </div>
      </div>

      {error ? (
        <section className="card">
          <LoadError message={error} onRetry={reload} />
        </section>
      ) : loading || !data ? (
        <div className="cards">
          {[0, 1, 2].map((i) => (
            <section className="card" key={i}>
              <SkeletonLines lines={4} />
            </section>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <section className="card">
          <Empty
            icon={<CalendarClock size={30} />}
            title={data.length === 0 ? 'No schedules yet' : 'Every schedule is archived'}
            body={data.length === 0 ? 'A schedule says when people work, what counts as late, and what makes a full or half day. Make the first one, then give it to people.' : 'Show the archived ones to restore one, or make a new schedule.'}
            action={
              <Link className="btn" to="/schedules/new">
                New schedule
              </Link>
            }
          />
        </section>
      ) : (
        <div className="cards">
          {shown.map((s) => (
            <section className="card schedule-card" key={s.id} data-archived={s.archived} aria-label={s.name}>
              <div className="card-head">
                <div>
                  <h2 className="card-title">{s.name}</h2>
                  <p className="card-sub">{s.rules.timeZone}</p>
                </div>
                <div className="badges">
                  {s.archived && <Badge color="var(--text-3)">Archived</Badge>}
                  <Badge color={s.rules.kind === 'fixed' ? 'var(--blue)' : 'var(--violet)'}>{s.rules.kind === 'fixed' ? 'Fixed hours' : 'Flexible'}</Badge>
                </div>
              </div>
              <p className="headline">{rulesHeadline(s.rules)}</p>
              <p className="muted">
                {s.peopleCount === 0 ? 'Nobody is on it today.' : `${s.peopleCount} ${s.peopleCount === 1 ? 'person is' : 'people are'} on it today.`}
              </p>
              <div className="actions">
                <Link className="btn ghost sm" to={`/schedules/${s.id}`}>
                  <Pencil size={15} /> Open
                </Link>
                {!s.archived && (
                  <button type="button" className="btn ghost sm" onClick={() => setGiving(s)}>
                    <UserPlus size={15} /> Give to people
                  </button>
                )}
                <Link className="btn ghost sm" to={`/schedules/new?copy=${s.id}`}>
                  <Copy size={15} /> Copy
                </Link>
                <button type="button" className="btn ghost sm" onClick={() => void setArchived(s, !s.archived)} disabled={busy === s.id}>
                  {s.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />} {s.archived ? 'Restore' : 'Archive'}
                </button>
              </div>
            </section>
          ))}
        </div>
      )}

      {giving && <AssignDialog target={{ kind: 'schedule', schedule: giving }} onClose={() => setGiving(null)} onDone={reload} />}
    </>
  );
}
