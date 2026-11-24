import { addDays, hoursFor, MINUTE, spanMinutes, weekdayOf, zonedToInstant, type LocalDate, type ScheduleAssignment } from '@delta-hrms/shared';
import { attendanceId, type AttendanceDayDoc, type StoredHistoryEntry } from '../db';

/*
 * Sample attendance for the sample company: a few past weeks of check-ins and check-outs,
 * written straight into the database as if people had made them at the time. It exists so the
 * home page, and later the calendar and the reports, have something to show on a developer's
 * machine. `npm run seed -- --history` asks for it; nothing else ever creates it.
 *
 * Only facts are written, exactly as a real punch writes them. How each day reads is worked
 * out by the engine like any other day.
 */

type Story = 'full' | 'late' | 'half' | 'forgot' | 'absent';

/** Fourteen working days of ordinary life: mostly full days, and one of each thing that goes wrong. */
const RHYTHM: readonly Story[] = ['full', 'full', 'late', 'full', 'full', 'half', 'full', 'full', 'full', 'forgot', 'full', 'full', 'absent', 'full'];

/** How long the one recorded break is, on schedules that record breaks. */
const BREAK_MINUTES = 35;

/**
 * One person's days from `from` up to, not including, `until`.
 * `index` moves the rhythm along so that people differ; the same person and dates always give the same days.
 * Nobody comes in on a date in `daysOff`: the holidays of the sample calendar.
 */
export function sampleHistory(person: { id: string; name: string; index: number }, assignment: ScheduleAssignment, from: LocalDate, until: LocalDate, daysOff: ReadonlySet<LocalDate> = new Set()): AttendanceDayDoc[] {
  const { rules } = assignment;
  const docs: AttendanceDayDoc[] = [];
  let workingDay = 0;

  for (let date = from; date < until; date = addDays(date, 1)) {
    const hours = hoursFor(rules, weekdayOf(date));
    if (!hours || daysOff.has(date)) continue;
    const story = RHYTHM[(workingDay++ + person.index * 3) % RHYTHM.length]!;
    if (story === 'absent') continue;

    // A few minutes either way, so no two days look copied.
    const jitter = (person.index * 7 + Number(date.slice(8, 10)) * 5) % 9;
    const start = hours.start ?? '10:00';
    const moment = (minutesAfterStart: number, seconds: number) => new Date(zonedToInstant(date, start, rules.timeZone).getTime() + minutesAfterStart * MINUTE + seconds * 1000).toISOString();

    const recordsBreaks = rules.break.mode === 'tracked';
    const fixedHours = Boolean(hours.start && hours.end);
    const fullLength = fixedHours ? spanMinutes(hours) : hours.requiredMinutes + BREAK_MINUTES + 10;
    const halfLength = Math.round((hours.halfDayMinutes + hours.fullDayMinutes) / 2) + (recordsBreaks ? BREAK_MINUTES : 0);

    const checkInAt = moment(story === 'late' && fixedHours ? rules.lateGraceMinutes + 6 + jitter * 3 : jitter - 6, 11 + jitter * 5);
    const checkOutAt = story === 'forgot' ? null : moment(story === 'half' ? halfLength : fullLength + 3 + jitter * 2, 44 - jitter * 4);
    const breaks = recordsBreaks ? [{ startAt: moment(180 + jitter, 20), endAt: moment(180 + jitter + BREAK_MINUTES, 5) }] : [];

    const entry = (kind: StoredHistoryEntry['kind'], at: string, after: unknown): StoredHistoryEntry => ({ at, by: person.id, byName: person.name, kind, after });
    const history = [
      entry('check_in', checkInAt, { checkInAt }),
      ...breaks.flatMap((b) => [entry('break_start', b.startAt, { startAt: b.startAt }), entry('break_end', b.endAt, { endAt: b.endAt })]),
      ...(checkOutAt ? [entry('check_out', checkOutAt, { checkOutAt })] : []),
    ];

    docs.push({
      _id: attendanceId(person.id, date),
      employeeId: person.id,
      date,
      assignmentId: assignment.id,
      checkInAt,
      checkOutAt,
      breaks,
      override: null,
      lateExcused: false,
      note: null,
      history,
      version: history.length,
      createdAt: checkInAt,
      updatedAt: checkOutAt ?? checkInAt,
    });
  }
  return docs;
}
