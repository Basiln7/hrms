import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, Copy, Pencil, Plus, Star, Trash2, UserPlus } from 'lucide-react';
import { HOLIDAY_YEAR_MAX, HOLIDAY_YEAR_MIN, type CalendarDetailPayload, type CopyYearResult, type Holiday } from '@delta-hrms/shared';
import { HolidayBadge } from '../components/attendance';
import { LoadError, SkeletonLines } from '../components/states';
import { Badge, Confirm, Empty } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { api, messageOf } from '../lib/api';
import { dayDate, shortDay } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';
import { CalendarNameDialog, CopyYearOutcome, GiveCalendarDialog, HolidayDialog, RemoveHolidayDialog } from './holidays/dialogs';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One holiday calendar: its holidays year by year, and who is on it. */
export default function HolidayCalendar() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  // No year until the first answer says which year it is on the server.
  const [year, setYear] = useState<number | null>(null);
  const { data, error, reload } = useLoad<CalendarDetailPayload>(`/holiday-calendars/${id}${queryOf({ year })}`);

  const [dialog, setDialog] = useState<'add' | 'rename' | 'give' | 'delete' | 'copy' | null>(null);
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [removing, setRemoving] = useState<Holiday | null>(null);
  const [copied, setCopied] = useState<CopyYearResult | null>(null);
  const [busy, setBusy] = useState(false);

  const back = (
    <Link className="back" to="/holiday-calendars">
      <ArrowLeft size={16} /> Holiday calendars
    </Link>
  );

  if (error && !data) {
    return (
      <>
        {back}
        <section className="card">
          <LoadError message={error} onRetry={reload} />
        </section>
      </>
    );
  }
  if (!data) {
    return (
      <>
        {back}
        <section className="card">
          <SkeletonLines lines={6} />
        </section>
      </>
    );
  }

  const shown = data.year;
  const run = async (request: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await request();
    } catch (failure) {
      toast(messageOf(failure), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyYear = () =>
    run(async () => {
      const result = await api.post<CopyYearResult>(`/holiday-calendars/${id}/copy-year`, { fromYear: shown });
      setCopied(result);
    });
  const makeDefault = () =>
    run(async () => {
      await api.post(`/holiday-calendars/${id}/default`);
      toast(`${data.name} is now the default calendar.`);
      reload();
    });
  const remove = () =>
    run(async () => {
      await api.delete(`/holiday-calendars/${id}`);
      toast(`${data.name} is deleted.`);
      navigate('/holiday-calendars');
    });

  // A new holiday is most likely for the year being looked at: start the date there.
  const suggestedDate = data.today.startsWith(String(shown)) ? data.today : `${shown}-01-01`;

  return (
    <>
      {back}
      <div className="page-head">
        <div>
          <h1>{data.name}</h1>
          <p>
            {data.peopleCount === 0 ? 'Nobody is on it today.' : `${count(data.peopleCount, 'person is', 'people are')} on it today.`}
            {data.isDefault ? ' It is the default: people getting their first schedule are put on it.' : ''}
          </p>
        </div>
        <div className="head-actions">
          {data.isDefault && (
            <Badge color="var(--accent-text)">
              <Star size={12} aria-hidden="true" /> Default
            </Badge>
          )}
          <button type="button" className="btn" onClick={() => setDialog('add')}>
            <Plus size={17} /> Add holiday
          </button>
        </div>
      </div>

      <div className="actions" style={{ marginBottom: 18 }}>
        <button type="button" className="btn ghost sm" onClick={() => setDialog('give')}>
          <UserPlus size={15} /> Give to people
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setDialog('rename')}>
          <Pencil size={15} /> Rename
        </button>
        {!data.isDefault && (
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void makeDefault()}>
            <Star size={15} /> Make default
          </button>
        )}
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setDialog('delete')}>
          <Trash2 size={15} /> Delete
        </button>
      </div>

      <div className="grid">
        <section className="card col-8" aria-labelledby="calendar-holidays">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="calendar-holidays">
                Holidays in {shown}
              </h2>
              <p className="card-sub">{data.years.length === 0 ? 'None in any year yet.' : `This calendar has holidays in ${data.years.join(', ')}.`}</p>
            </div>
            <div className="stepper" role="group" aria-label="Year">
              <button type="button" className="icon-btn sm" aria-label={`Show ${shown - 1}`} disabled={shown <= HOLIDAY_YEAR_MIN} onClick={() => setYear(shown - 1)}>
                <ChevronLeft size={17} />
              </button>
              <b>{shown}</b>
              <button type="button" className="icon-btn sm" aria-label={`Show ${shown + 1}`} disabled={shown >= HOLIDAY_YEAR_MAX} onClick={() => setYear(shown + 1)}>
                <ChevronRight size={17} />
              </button>
            </div>
          </div>

          {data.holidays.length === 0 ? (
            <Empty
              icon={<CalendarPlus size={30} />}
              title={`No holidays in ${shown}`}
              body={data.years.includes(shown - 1) ? `Add them one by one, or go back to ${shown - 1} and copy that year here to review.` : 'Add the public holidays, the company’s own days off, and any weekly off that is to be worked.'}
              action={
                <button type="button" className="btn" onClick={() => setDialog('add')}>
                  Add holiday
                </button>
              }
            />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Holiday</th>
                      <th scope="col">Kind</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holidays.map((h) => (
                      <tr key={h.id}>
                        <td className="nowrap">
                          <b>{shortDay(h.date)}</b>
                          {h.date <= data.today && <span className="cell-none"> · begun</span>}
                        </td>
                        <td>
                          {h.name}
                          {h.description && <span className="cell-sub">{h.description}</span>}
                        </td>
                        <td>
                          <HolidayBadge type={h.type} />
                        </td>
                        <td className="cell-end">
                          <span className="actions">
                            <button type="button" className="icon-btn sm" aria-label={`Change ${h.name}`} onClick={() => setEditing(h)}>
                              <Pencil size={15} />
                            </button>
                            <button type="button" className="icon-btn sm" aria-label={`Remove ${h.name}`} onClick={() => setRemoving(h)}>
                              <Trash2 size={15} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <button type="button" className="btn ghost sm" disabled={busy || shown >= HOLIDAY_YEAR_MAX} onClick={() => setDialog('copy')}>
                  <Copy size={15} /> Copy these to {shown + 1}
                </button>
              </div>
            </>
          )}
        </section>

        <section className="card col-4" aria-labelledby="calendar-people">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="calendar-people">
                On this calendar
              </h2>
              <p className="card-sub">Today</p>
            </div>
          </div>
          {data.people.length === 0 ? (
            <p className="muted">Nobody yet. “Give to people” puts them on it from a date.</p>
          ) : (
            <ul className="people-list">
              {data.people.map((p) => (
                <li key={p.id}>
                  <Link to={`/employees/${p.id}`}>{p.name}</Link>
                  <span>{[p.departmentName, `since ${dayDate(p.effectiveFrom)}`].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {dialog === 'add' && (
        <HolidayDialog
          calendarId={id}
          suggestedDate={suggestedDate}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            toast(`${saved.name} is added.`);
            setYear(Number(saved.date.slice(0, 4)));
            reload();
          }}
        />
      )}
      {editing && (
        <HolidayDialog
          calendarId={id}
          holiday={editing}
          suggestedDate={suggestedDate}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            toast('The holiday is saved.');
            setYear(Number(saved.date.slice(0, 4)));
            reload();
          }}
        />
      )}
      {removing && (
        <RemoveHolidayDialog
          holiday={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            toast(`${removing.name} is removed.`);
            reload();
          }}
        />
      )}
      {dialog === 'rename' && (
        <CalendarNameDialog
          calendar={data}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast('The name is saved.');
            reload();
          }}
        />
      )}
      {dialog === 'give' && <GiveCalendarDialog calendar={data} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'copy' && (
        <Confirm
          title={`Copy ${shown} to ${shown + 1}?`}
          body={`Each of the ${count(data.holidays.length, 'holiday', 'holidays')} is copied to the same date in ${shown + 1}, for you to review. Dates that already have a holiday, or that have already begun, are left out and listed.`}
          confirmLabel={`Copy to ${shown + 1}`}
          onConfirm={() => void copyYear()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'delete' && (
        <Confirm
          title={`Delete “${data.name}”?`}
          body="The calendar and its holidays are deleted for good. It can only be deleted if nobody was ever on it; otherwise people's past days would lose their holidays."
          confirmLabel="Delete calendar"
          onConfirm={() => void remove()}
          onClose={() => setDialog(null)}
        />
      )}
      {copied && (
        <CopyYearOutcome
          result={copied}
          onClose={() => {
            setCopied(null);
            if (copied.copied.length > 0) setYear(copied.toYear);
            reload();
          }}
        />
      )}
    </>
  );
}
