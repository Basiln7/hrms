import { Router } from 'express';
import { z } from 'zod';
import type { ScheduleDetailPayload, SchedulePerson } from '@delta-hrms/shared';
import { db } from '../db';
import { contextOf, requirePermission } from '../http/context';
import { notFound } from '../http/errors';
import { id, idList, localDate, scheduleRules, text } from '../http/schemas';
import { guardOwnRecord } from '../services/access';
import { archiveSchedule, assignSchedule, cancelAssignment, createSchedule, peopleOnSchedules, scheduleRows, toSchedule, updateSchedule } from '../services/schedules';

/** Standard schedules. All of it needs `schedules.manage`. */
export const scheduleRoutes = Router();
scheduleRoutes.use(requirePermission('schedules.manage'));

scheduleRoutes.get('/', async (_req, res) => {
  res.json(await scheduleRows());
});

scheduleRoutes.post('/', async (req, res) => {
  const input = z.strictObject({ rules: scheduleRules }).parse(req.body);
  res.status(201).json(await createSchedule(contextOf(req), input.rules));
});

scheduleRoutes.get('/:id', async (req, res) => {
  const doc = await db().schedules.findOne({ _id: id.parse(req.params.id) });
  if (!doc) throw notFound('That schedule no longer exists.');
  const onIt = (await peopleOnSchedules()).get(doc._id) ?? [];
  const since = new Map(onIt.map((p) => [p.employeeId, p.effectiveFrom]));
  const employees = await db()
    .employees.find({ _id: { $in: [...since.keys()] } }, { projection: { name: 1, code: 1, departmentId: 1, status: 1 } })
    .sort({ name: 1 })
    .toArray();
  const departments = new Map((await db().departments.find({}, { projection: { name: 1 } }).toArray()).map((d) => [d._id, d.name]));
  const people: SchedulePerson[] = employees.map((e) => ({
    id: e._id,
    code: e.code,
    name: e.name,
    departmentName: (e.departmentId && departments.get(e.departmentId)) || null,
    status: e.status,
    effectiveFrom: since.get(e._id)!,
  }));
  const payload: ScheduleDetailPayload = { ...toSchedule(doc), people };
  res.json(payload);
});

/** Changes the standard schedule only. The people on it keep the copy they have until they are given the new one from a date. */
scheduleRoutes.patch('/:id', async (req, res) => {
  const input = z.strictObject({ rules: scheduleRules }).parse(req.body);
  res.json(await updateSchedule(contextOf(req), id.parse(req.params.id), input.rules));
});

scheduleRoutes.post('/:id/archive', async (req, res) => {
  const input = z.strictObject({ archived: z.boolean() }).parse(req.body);
  res.json(await archiveSchedule(contextOf(req), id.parse(req.params.id), input.archived));
});

/** Giving people a schedule from a date, and cancelling one that has not started. */
export const assignmentRoutes = Router();
assignmentRoutes.use(requirePermission('schedules.manage'));

assignmentRoutes.post('/', async (req, res) => {
  const input = z
    .strictObject({
      employeeIds: idList,
      scheduleId: id.nullable(),
      rules: scheduleRules.nullable(),
      effectiveFrom: localDate,
      note: text(300),
      holidayCalendarId: id.nullable().optional(),
    })
    .refine((v) => (v.scheduleId === null) !== (v.rules === null), 'Choose a standard schedule, or set the rules for this person: one or the other.')
    .parse(req.body);
  res.json(await assignSchedule(contextOf(req), input));
});

assignmentRoutes.delete('/:id', async (req, res) => {
  const ctx = contextOf(req);
  await cancelAssignment(ctx, id.parse(req.params.id), (employeeId) => guardOwnRecord(ctx, [employeeId]));
  res.status(204).end();
});
