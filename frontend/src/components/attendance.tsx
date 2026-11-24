import type { ReactNode } from 'react';
import { CalendarDays, CalendarOff, CircleCheck, CircleMinus, CircleSlash, CircleX, Clock, ClockAlert, Coffee, Contrast, Timer, TreePalm, TriangleAlert, type LucideIcon } from 'lucide-react';
import { flagWords, formatMinutes, HOLIDAY_TYPE_INFO, localParts, STATUS_LABEL, type DayResult, type DayStatus, type HolidayType, type PeriodSummary, type Tone } from '@delta-hrms/shared';
import { dayCount, shortDay } from '../lib/format';
import { Badge } from './ui';

/*
 * How attendance looks, in one place. A status is always its word, an icon and a colour
 * together, never colour alone. The words come from `shared`, so the home page, the calendar,
 * the tables and the exports all say the same thing.
 */

const STATUS_LOOK: Record<DayStatus, { icon: LucideIcon; color: string }> = {
  present: { icon: CircleCheck, color: 'var(--green)' },
  half_day: { icon: Contrast, color: 'var(--amber)' },
  absent: { icon: CircleX, color: 'var(--red)' },
  unresolved: { icon: TriangleAlert, color: 'var(--orange)' },
  leave: { icon: TreePalm, color: 'var(--violet)' },
  holiday: { icon: CalendarOff, color: 'var(--blue)' },
  weekly_off: { icon: CircleMinus, color: 'var(--text-2)' },
  working: { icon: Timer, color: 'var(--accent-text)' },
  on_break: { icon: Coffee, color: 'var(--blue)' },
  not_in: { icon: ClockAlert, color: 'var(--amber)' },
  not_due: { icon: Clock, color: 'var(--text-2)' },
  upcoming: { icon: CalendarDays, color: 'var(--text-2)' },
  not_applicable: { icon: CircleSlash, color: 'var(--text-2)' },
};

export const TONE_COLOR: Record<Tone, string> = { good: 'var(--green)', warn: 'var(--amber)', neutral: 'var(--text-2)' };

/** The icon and colour of a status, for places that lay them out themselves (a calendar cell). */
export const statusLook = (status: DayStatus) => STATUS_LOOK[status];

/** A day's status as a badge: icon, word and colour. */
export function StatusBadge({ status }: { status: DayStatus }) {
  const { icon: Icon, color } = STATUS_LOOK[status];
  return (
    <Badge color={color}>
      <Icon size={13} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** What else is true of a day ("Late by 26 min", "Left 2 h early"), as badges. Nothing when there is nothing to say. */
export function FlagBadges({ day }: { day: DayResult }) {
  const words = flagWords(day);
  if (words.length === 0) return null;
  return (
    <>
      {words.map((word) => (
        <Badge key={word.flag} color={TONE_COLOR[word.tone]}>
          {word.text}
        </Badge>
      ))}
    </>
  );
}

const HOLIDAY_COLOR: Record<HolidayType, string> = { public: 'var(--blue)', company: 'var(--accent-text)', optional: 'var(--amber)', special_working_day: 'var(--violet)' };

/** The kind of a holiday, in its words and colour. */
export function HolidayBadge({ type }: { type: HolidayType }) {
  return <Badge color={HOLIDAY_COLOR[type]}>{HOLIDAY_TYPE_INFO[type].label}</Badge>;
}

/** "8 h 10 min" with the numbers large and the units small, for a figure that stands on its own. */
export function Duration({ minutes }: { minutes: number }) {
  const parts: ReactNode[] = [];
  formatMinutes(minutes)
    .split(' ')
    .forEach((part, index) => parts.push(/^\d/.test(part) ? <span key={index}>{part}</span> : <small key={index}> {part} </small>));
  return <>{parts}</>;
}

/**
 * A period in numbers. Every one of them is the engine's own addition over the days
 * (`summarize` in shared), sent by the API: nothing is counted in the browser.
 */
export function SummaryTiles({ summary }: { summary: PeriodSummary }) {
  return (
    <dl className="tiles">
      <div>
        <dt>Present</dt>
        <dd>{dayCount(summary.presentDays)}</dd>
      </div>
      <div>
        <dt>Half-days</dt>
        <dd>{dayCount(summary.halfDays)}</dd>
      </div>
      <div>
        <dt>Leave</dt>
        <dd>
          {dayCount(summary.leaveDays)}
          {summary.unpaidLeaveDays > 0 && <small> {dayCount(summary.unpaidLeaveDays)} unpaid</small>}
        </dd>
      </div>
      <div>
        <dt>Absent</dt>
        <dd>{dayCount(summary.absentDays)}</dd>
      </div>
      <div>
        <dt>Late entries</dt>
        <dd>{dayCount(summary.lateEntries)}</dd>
      </div>
      <div>
        <dt>Time worked</dt>
        <dd>
          <Duration minutes={summary.workedMinutes} />
        </dd>
      </div>
    </dl>
  );
}

/** "08:55 to 18:05", "08:55, no check-out", or nothing when nothing was punched. */
export function timesOf(day: DayResult, timeZone: string): string | null {
  if (!day.checkInAt) return null;
  const time = (moment: string) => localParts(moment, timeZone).time;
  return day.checkOutAt ? `${time(day.checkInAt)} to ${time(day.checkOutAt)}` : `${time(day.checkInAt)}, no check-out`;
}

/**
 * Days as rows, each exactly as the engine reads it now: the date, the status and what else
 * is true of it, the times, the time worked. With `onOpen` each row opens the day in full.
 */
export function DayRows({ days, timeZone, onOpen }: { days: DayResult[]; timeZone: string; onOpen?: (date: string) => void }) {
  return (
    <ul className="day-list" data-clickable={onOpen ? true : undefined}>
      {days.map((day) => {
        const row = (
          <>
            <b className="day-date">{shortDay(day.date)}</b>
            <span className="badges">
              <StatusBadge status={day.status} />
              {day.holiday && <span className="day-holiday">{day.holiday.name}</span>}
              {day.leave?.name && <span className="day-holiday">{day.leave.name}</span>}
              <FlagBadges day={day} />
            </span>
            <span className="day-times">{timesOf(day, timeZone) ?? ''}</span>
            <span className="day-worked num">{day.checkOutAt ? formatMinutes(day.workedMinutes) : ''}</span>
          </>
        );
        return (
          <li key={day.date}>
            {onOpen ? (
              <button type="button" className="day-row" onClick={() => onOpen(day.date)}>
                {row}
              </button>
            ) : (
              <div className="day-row">{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A day on one line: how it reads, what else is true of it, its times and the time worked. */
export function DayLine({ day, timeZone }: { day: DayResult; timeZone: string }) {
  const times = timesOf(day, timeZone);
  return (
    <span className="day-line">
      <span className="badges">
        <StatusBadge status={day.status} />
        <FlagBadges day={day} />
      </span>
      {times && (
        <span className="day-times">
          {times}
          {day.checkOutAt ? ` · ${formatMinutes(day.workedMinutes)}` : ''}
        </span>
      )}
    </span>
  );
}
