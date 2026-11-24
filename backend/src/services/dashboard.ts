import { addDays, HOME_ANNOUNCEMENTS, leaveYearLabel, RECENT_DAYS, summarize, UPCOMING_HOLIDAYS, type MyDashboardPayload } from '@delta-hrms/shared';
import { clock } from '../clock';
import type { Account } from '../db';
import { feedFor } from './announcements';
import { contextFor, daysIn, todayFor } from './attendance';
import { calendarNames } from './calendarStore';
import { pendingOf } from './corrections';
import { upcomingFor } from './holidays';
import { myLeaveAhead } from './leave';
import { balanceRows, holderOf, viewOf } from './leaveAccounts';

/** How many approved leaves that are not over yet the home page lists. */
const UPCOMING_LEAVE = 3;

/**
 * Everything the employee's home page shows about their own attendance: today, this month so
 * far, the last few days, and the next holidays. All of it is read at one moment, from the
 * same facts, by the same engine, so the numbers on the page always agree with each other.
 *
 * It takes the signed-in person and nothing else: there is no way to ask it for someone else.
 */
export async function myDashboard(employee: Account): Promise<MyDashboardPayload> {
  const now = clock.now();
  const person = await contextFor(employee, now);
  const today = await todayFor(employee, { now, person });

  // The month is the calendar month of today's date, in the person's own time zone.
  const monthStart = `${today.today.slice(0, 7)}-01`;
  // "Recent" is what came before the day in the Today card, which for a night shift is yesterday's date.
  const before = today.day.date < today.today ? today.day.date : today.today;
  const recentFrom = addDays(before, -RECENT_DAYS);
  const [days, names, corrections, holder, ahead, feed] = await Promise.all([
    daysIn(employee.id, person, recentFrom < monthStart ? recentFrom : monthStart, today.today, now),
    calendarNames([person.calendarId]),
    pendingOf(employee.id),
    holderOf(employee, today.today),
    myLeaveAhead(employee, today.today, UPCOMING_LEAVE),
    feedFor(employee),
  ]);
  // What is left of each kind of leave in their policy, this leave year. Read, never written, here.
  const balances = balanceRows(holder, viewOf(holder, holder.currentYear, now.toISOString())).filter((row) => row.entry !== null);

  return {
    today,
    month: { from: monthStart, to: today.today, summary: summarize(days.filter((day) => day.date >= monthStart)) },
    recent: days.filter((day) => day.date >= recentFrom && day.date < before && day.status !== 'not_applicable').reverse(),
    holidays: { calendarName: (person.calendarId && names.get(person.calendarId)) || null, upcoming: upcomingFor(person, today.today, UPCOMING_HOLIDAYS) },
    corrections,
    announcements: { items: feed.items.slice(0, HOME_ANNOUNCEMENTS), total: feed.items.length, unread: feed.unread },
    leave: { yearLabel: leaveYearLabel(holder.currentYear, holder.startMonth), hasPolicy: holder.policy !== null, balances, ...ahead },
  };
}
