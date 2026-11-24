import { db } from '../db';

/*
 * The two things about holiday calendars that schedules need to know: which one is the
 * company default, and what the calendars are called. They live apart from the rest of the
 * holiday code so that schedules and holidays can each use the other without a circle.
 */

/** The calendar preselected for people getting their first schedule, or null. */
export async function defaultCalendarId(): Promise<string | null> {
  const doc = await db().meta.findOne({ _id: 'holidays' });
  return (doc?.value as { defaultCalendarId?: string | null } | undefined)?.defaultCalendarId ?? null;
}

export async function saveDefaultCalendar(id: string | null) {
  await db().meta.updateOne({ _id: 'holidays' }, { $set: { value: { defaultCalendarId: id } } }, { upsert: true });
}

/** The names of some calendars, by id. An id whose calendar is gone is simply not in the answer. */
export async function calendarNames(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const docs = await db().holidayCalendars.find({ _id: { $in: wanted } }, { projection: { name: 1 } }).toArray();
  return new Map(docs.map((d) => [d._id, d.name]));
}
