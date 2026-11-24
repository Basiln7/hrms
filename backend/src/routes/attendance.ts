import { Router, type Request } from 'express';
import { z } from 'zod';
import { DAY_NOTE_MAX, isHolidayYear, isLocalMonth, REASON_MAX, RECORD_FLAGS, RECORD_STATUSES, type DayFlag } from '@delta-hrms/shared';
import { contextOf, requirePermission } from '../http/context';
import { forbidden } from '../http/errors';
import { id, localDate } from '../http/schemas';
import { checkIn, checkOut, endBreak, monthCalendar, startBreak, todayFor } from '../services/attendance';
import { correctDay, dayDetail, noteDay } from '../services/corrections';
import { records, recordsCsv } from '../services/reports';
import { format, peopleFilter, sendCsv } from './reports';

/**
 * Attendance. The punches act on the signed-in person and nobody else, and take nothing from
 * the request: no time, no date, no employee. A body with anything in it is refused, so a
 * client cannot even appear to supply its own clock.
 */
export const attendanceRoutes = Router();

const nothing = z.strictObject({}, 'A punch takes no details: the time is the server’s.');
const emptyBody = (req: Request) => nothing.parse(req.body ?? {});

attendanceRoutes.get('/today', async (req, res) => {
  res.json(await todayFor(contextOf(req).employee));
});

attendanceRoutes.post('/check-in', async (req, res) => {
  emptyBody(req);
  res.json(await checkIn(contextOf(req), req.get('user-agent')));
});

attendanceRoutes.post('/check-out', async (req, res) => {
  emptyBody(req);
  res.json(await checkOut(contextOf(req), req.get('user-agent')));
});

attendanceRoutes.post('/break/start', async (req, res) => {
  emptyBody(req);
  res.json(await startBreak(contextOf(req), req.get('user-agent')));
});

attendanceRoutes.post('/break/end', async (req, res) => {
  emptyBody(req);
  res.json(await endBreak(contextOf(req), req.get('user-agent')));
});

const calendarQuery = z.strictObject({
  employeeId: id.optional(),
  month: z
    .string()
    .refine((value) => isLocalMonth(value) && isHolidayYear(Number(value.slice(0, 4))), 'That month is not valid.')
    .optional(),
});

/** A month, day by day, with its totals. With no employee named it is your own; anyone else's needs you to be allowed to see them. */
attendanceRoutes.get('/calendar', async (req, res) => {
  const query = calendarQuery.parse(req.query);
  const ctx = contextOf(req);
  res.json(await monthCalendar(ctx, query.employeeId ?? ctx.employee.id, query.month));
});

/** One day in full: how it reads now, what was recorded, and its history. Your own, or anyone you may see. */
attendanceRoutes.get('/days/:employeeId/:date', async (req, res) => {
  res.json(await dayDetail(contextOf(req), id.parse(req.params.employeeId), localDate.parse(req.params.date)));
});

const localDateTime = z.string().max(16).nullable();

/** HR corrects a day directly, with a reason. Not on their own record, and not over a day that changed since they looked. */
attendanceRoutes.post('/days/:employeeId/:date/correct', requirePermission('attendance.edit'), async (req, res) => {
  const input = z
    .strictObject({ checkIn: localDateTime, checkOut: localDateTime, override: z.enum(['present', 'half_day']).nullable(), lateExcused: z.boolean(), reason: z.string().max(REASON_MAX * 2), dayVersion: z.number().int().min(0) })
    .parse(req.body);
  res.json(await correctDay(contextOf(req), id.parse(req.params.employeeId), localDate.parse(req.params.date), input));
});

/** HR's note on a day, shown to the person and their managers. Empty text removes it. */
attendanceRoutes.put('/days/:employeeId/:date/note', requirePermission('attendance.edit'), async (req, res) => {
  const input = z.strictObject({ text: z.string().max(DAY_NOTE_MAX * 2) }).parse(req.body);
  res.json(await noteDay(contextOf(req), id.parse(req.params.employeeId), localDate.parse(req.params.date), input.text));
});

/**
 * Everyone's days between two dates, for those who may see reports: narrowed by department,
 * manager, person, status and mark. Whose days those are is decided in the service. As a
 * file it needs the permission to export.
 */
attendanceRoutes.get('/records', requirePermission('reports.view'), async (req, res) => {
  const ctx = contextOf(req);
  const { format: as, ...asked } = z
    .strictObject({
      from: localDate.optional(),
      to: localDate.optional(),
      ...peopleFilter,
      employeeId: id.optional(),
      status: z.enum(RECORD_STATUSES).optional(),
      flag: z.enum(RECORD_FLAGS as [DayFlag, ...DayFlag[]]).optional(),
      page: z.coerce.number().int().min(1).max(10_000).default(1),
      format,
    })
    .parse(req.query);
  if (as === 'csv') {
    if (!ctx.can('reports.export')) throw forbidden('Your role cannot download reports.');
    sendCsv(res, await recordsCsv(ctx, asked));
  } else res.json(await records(ctx, asked));
});
