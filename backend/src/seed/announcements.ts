import { DAY, HOUR, type Announcement, type Audience } from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, toDoc } from '../db';
import { newId } from '../ids';

/*
 * Announcements for the sample company: one pinned for everyone, one for a department, one
 * for two roles, one that has not started yet and one that is over, so that every state and
 * every kind of audience can be looked at.
 */

interface Sample {
  title: string;
  body: string;
  important?: boolean;
  pinned?: boolean;
  /** Hours from now: negative is in the past. */
  startsIn: number;
  expiresIn?: number;
  audience: (departments: ReadonlyMap<string, string>) => Audience;
}

const everyone = (): Audience => ({ kind: 'all' });

const SAMPLES: readonly Sample[] = [
  {
    title: 'Close your attendance for the month by the 28th',
    body: 'Please make sure every working day this month has a check-in and a check-out, or a correction request, by the 28th.\n\nDays that are still unresolved after that are settled by HR.',
    important: true,
    pinned: true,
    startsIn: -2 * 24,
    audience: everyone,
  },
  {
    title: 'The office is closed for maintenance next Saturday',
    body: 'The building is closed all day for electrical work. Nobody needs to come in.\n\nIf Saturday is a working day on your schedule, ask your manager whether to work from home.',
    startsIn: -5 * 24,
    expiresIn: 10 * 24,
    audience: everyone,
  },
  {
    title: 'Sales review moved to Thursday, 4 pm',
    body: 'This week only. Bring your numbers for the quarter so far.',
    startsIn: -20,
    expiresIn: 5 * 24,
    audience: (departments) => ({ kind: 'departments', departmentIds: [departments.get('Sales')!] }),
  },
  {
    title: 'Approvals: please clear your inbox by Friday',
    body: 'Leave and correction requests that wait longer than a week hold up payroll. Anything you cannot decide, pass to HR.',
    startsIn: -6,
    audience: () => ({ kind: 'roles', roles: ['Manager', 'HR'] }),
  },
  {
    title: 'New leave year: what carries over on 1 January',
    body: 'Unused earned leave carries over, up to ten days. Casual and sick leave start afresh.',
    startsIn: 3 * 24,
    audience: everyone,
  },
  {
    title: 'Flu vaccination camp in the lobby',
    body: 'Free for everyone, 10 am to 1 pm. Bring your employee code.',
    startsIn: -20 * 24,
    expiresIn: -6 * 24,
    audience: everyone,
  },
];

/** Writes the sample announcements, posted by one person. */
export async function seedAnnouncements(by: { id: string; name: string }, departments: ReadonlyMap<string, string>) {
  const now = clock.now().getTime();
  const at = (hours: number) => new Date(now + hours * HOUR).toISOString();
  const announcements: Announcement[] = SAMPLES.map((sample) => {
    // Posted when it started, or a day ago for one that is still to start.
    const posted = at(Math.min(sample.startsIn, -DAY / HOUR));
    return {
      id: newId('ann'),
      title: sample.title,
      body: sample.body,
      importance: sample.important ? 'important' : 'normal',
      pinned: Boolean(sample.pinned),
      startsAt: at(sample.startsIn),
      expiresAt: sample.expiresIn === undefined ? null : at(sample.expiresIn),
      audience: sample.audience(departments),
      revisedAt: posted,
      createdBy: by.id,
      createdByName: by.name,
      createdAt: posted,
      updatedAt: posted,
    };
  });
  await db().announcements.insertMany(announcements.map(toDoc));
}
