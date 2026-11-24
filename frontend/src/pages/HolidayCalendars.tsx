import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarRange, Pencil, Plus, Star, Trash2, TriangleAlert, UserPlus } from 'lucide-react';
import type { CalendarListPayload, CalendarRow } from '@delta-hrms/shared';
import { LoadError, SkeletonLines } from '../components/states';
import { Badge, Confirm, Empty } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { api, messageOf } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { CalendarNameDialog, GiveCalendarDialog } from './holidays/dialogs';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The company's holiday calendars: named sets of holidays that people are put on from a date. */
export default function HolidayCalendars() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<CalendarListPayload>('/holiday-calendars');
  const [naming, setNaming] = useState<{ calendar?: CalendarRow } | null>(null);
  const [giving, setGiving] = useState<CalendarRow | null>(null);
  const [deleting, setDeleting] = useState<CalendarRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (calendar: CalendarRow, request: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(calendar.id);
    try {
      await request();
      toast(done);
    } catch (failure) {
      toast(messageOf(failure), 'error');
    } finally {
      setBusy(null);
      reload();
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Holiday calendars</h1>
          <p>Each calendar is a set of holidays. A person is on one from a date, and their days before that date keep the calendar they had then.</p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn" onClick={() => setNaming({})}>
            <Plus size={17} /> New calendar
          </button>
        </div>
      </div>

      {error ? (
        <section className="card">
          <LoadError message={error} onRetry={reload} />
        </section>
      ) : loading || !data ? (
        <div className="cards">
          {[0, 1].map((i) => (
            <section className="card" key={i}>
              <SkeletonLines lines={4} />
            </section>
          ))}
        </div>
      ) : data.calendars.length === 0 ? (
        <section className="card">
          <Empty
            icon={<CalendarRange size={30} />}
            title="No holiday calendars yet"
            body="Without one, no day is a holiday for anybody: a public holiday nobody works would read as an absence. Make a calendar, add its holidays, then give it to people."
            action={
              <button type="button" className="btn" onClick={() => setNaming({})}>
                New calendar
              </button>
            }
          />
        </section>
      ) : (
        <>
          {data.withoutCalendar > 0 && (
            <p className="note warn" style={{ marginTop: 0, marginBottom: 18 }}>
              <TriangleAlert size={16} aria-hidden="true" />
              <span>
                {count(data.withoutCalendar, 'person with a work schedule is', 'people with a work schedule are')} on no holiday calendar, so no day is a holiday for them. Use “Give to people” on the calendar they should be on.
              </span>
            </p>
          )}
          <div className="cards">
            {data.calendars.map((c) => (
              <section className="card schedule-card" key={c.id} aria-label={c.name}>
                <div className="card-head">
                  <div>
                    <h2 className="card-title">{c.name}</h2>
                    <p className="card-sub">
                      {count(c.holidayCount, 'holiday', 'holidays')} in {data.year}
                    </p>
                  </div>
                  {c.isDefault && (
                    <Badge color="var(--accent-text)">
                      <Star size={12} aria-hidden="true" /> Default
                    </Badge>
                  )}
                </div>
                <p className="muted">
                  {c.peopleCount === 0 ? 'Nobody is on it today.' : `${count(c.peopleCount, 'person is', 'people are')} on it today.`}
                  {c.isDefault ? ' People getting their first schedule are put on it.' : ''}
                </p>
                <div className="actions">
                  <Link className="btn ghost sm" to={`/holiday-calendars/${c.id}`}>
                    <CalendarRange size={15} /> Open
                  </Link>
                  <button type="button" className="btn ghost sm" onClick={() => setGiving(c)}>
                    <UserPlus size={15} /> Give to people
                  </button>
                  {!c.isDefault && (
                    <button type="button" className="btn ghost sm" disabled={busy === c.id} onClick={() => void act(c, () => api.post(`/holiday-calendars/${c.id}/default`), `${c.name} is now the default calendar.`)}>
                      <Star size={15} /> Make default
                    </button>
                  )}
                  <button type="button" className="btn ghost sm" onClick={() => setNaming({ calendar: c })}>
                    <Pencil size={15} /> Rename
                  </button>
                  <button type="button" className="btn ghost sm" disabled={busy === c.id} onClick={() => setDeleting(c)}>
                    <Trash2 size={15} /> Delete
                  </button>
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      {naming && (
        <CalendarNameDialog
          calendar={naming.calendar}
          onClose={() => setNaming(null)}
          onSaved={(saved) => {
            toast(naming.calendar ? 'The name is saved.' : `${saved.name} is created. Open it to add its holidays.`);
            reload();
          }}
        />
      )}
      {giving && <GiveCalendarDialog calendar={giving} onClose={() => setGiving(null)} onDone={reload} />}
      {deleting && (
        <Confirm
          title={`Delete “${deleting.name}”?`}
          body={`The calendar and its holidays are deleted for good. It can only be deleted if nobody was ever on it; otherwise people's past days would lose their holidays.`}
          confirmLabel="Delete calendar"
          onConfirm={() => void act(deleting, () => api.delete(`/holiday-calendars/${deleting.id}`), `${deleting.name} is deleted.`)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
