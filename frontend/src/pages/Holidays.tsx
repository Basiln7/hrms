import { useState } from 'react';
import { ChevronLeft, ChevronRight, TreePalm } from 'lucide-react';
import { daysBetween, HOLIDAY_TYPE_INFO, HOLIDAY_YEAR_MAX, HOLIDAY_YEAR_MIN, WEEKDAY_NAMES, weekdayOf, type MyHolidaysPayload } from '@delta-hrms/shared';
import { HolidayBadge } from '../components/attendance';
import { LoadError, SkeletonLines } from '../components/states';
import { Empty } from '../components/ui';
import { shortDay } from '../lib/format';
import { queryOf, useLoad } from '../lib/useLoad';

/** "today", "tomorrow", "in 12 days". */
const away = (days: number) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);

/** The signed-in person's holidays for a year: each from the calendar they are on at that date. */
export default function Holidays() {
  // No year until the first answer says which year it is on the server.
  const [year, setYear] = useState<number | null>(null);
  const { data, error, reload } = useLoad<MyHolidaysPayload>(`/holidays/mine${queryOf({ year })}`);

  const shown = data?.year ?? null;
  // The next one to come, today included, whichever year is on screen: the one to look forward to.
  const next = data?.next ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Holidays</h1>
          <p>
            {data ? (data.calendarName ? `Your holiday calendar: ${data.calendarName}. HR keeps it.` : 'You are not on a holiday calendar.') : 'Your holidays for the year.'}
            {data && next ? ` Next: ${next.name}, ${shortDay(next.date)}, ${away(daysBetween(data.today, next.date))}.` : ''}
          </p>
        </div>
        {shown !== null && (
          <div className="stepper" role="group" aria-label="Year">
            <button type="button" className="icon-btn sm" aria-label={`Show ${shown - 1}`} disabled={shown <= HOLIDAY_YEAR_MIN} onClick={() => setYear(shown - 1)}>
              <ChevronLeft size={17} />
            </button>
            <b>{shown}</b>
            <button type="button" className="icon-btn sm" aria-label={`Show ${shown + 1}`} disabled={shown >= HOLIDAY_YEAR_MAX} onClick={() => setYear(shown + 1)}>
              <ChevronRight size={17} />
            </button>
          </div>
        )}
      </div>

      <section className="card" aria-label={shown ? `Holidays in ${shown}` : 'Holidays'}>
        {error && !data ? (
          <LoadError message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonLines lines={6} />
        ) : data.holidays.length === 0 ? (
          <Empty
            icon={<TreePalm size={30} />}
            title={data.calendarName ? `No holidays in ${data.year}` : 'No holiday calendar'}
            body={
              data.calendarName
                ? `Your calendar has nothing for ${data.year} yet. HR adds each year's holidays.`
                : 'Holidays come with your work schedule. Until HR puts you on a holiday calendar, no day is a holiday for you: ask them if that is wrong.'
            }
          />
        ) : (
          <ul className="holiday-list">
            {data.holidays.map((h) => {
              const past = h.date < data.today;
              const isNext = h.date === next?.date;
              return (
                <li key={h.date} data-past={past} data-next={isNext} aria-current={isNext ? 'date' : undefined}>
                  <div className="holiday-date">
                    <b>{shortDay(h.date).split(' ').slice(1).join(' ')}</b>
                    <span>{WEEKDAY_NAMES[weekdayOf(h.date)]}</span>
                  </div>
                  <div className="holiday-main">
                    <b>{h.name}</b>
                    <span>{h.description || HOLIDAY_TYPE_INFO[h.type].hint}</span>
                  </div>
                  <div className="badges">
                    {isNext && <span className="holiday-next">Next · {away(daysBetween(data.today, h.date))}</span>}
                    <HolidayBadge type={h.type} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
