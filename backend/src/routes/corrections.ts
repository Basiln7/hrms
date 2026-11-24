import { Router } from 'express';
import { z } from 'zod';
import { CORRECTION_TYPES, REASON_MAX } from '@delta-hrms/shared';
import { contextOf } from '../http/context';
import { id, localDate, text } from '../http/schemas';
import { approveCorrection, cancelCorrection, listCorrections, rejectCorrection, submitCorrection } from '../services/corrections';

/**
 * Requests to correct a day. Anyone may ask for their own days and cancel what they asked;
 * deciding is for the people the shared `approvalVerdict` allows, checked in the service on
 * every call. A request that is not the caller's to see is answered as if it did not exist.
 */
export const correctionRoutes = Router();

// Only the shape is checked here. Whether the request fits the day is decided by the shared
// `validateCorrection`, the same code the form runs.
const localDateTime = z.string().max(16).nullable();
const input = z.strictObject({
  date: localDate,
  type: z.enum(CORRECTION_TYPES),
  checkIn: localDateTime,
  checkOut: localDateTime,
  status: z.enum(['present', 'half_day']).nullable(),
  reason: z.string().max(REASON_MAX * 2),
});

correctionRoutes.get('/', async (req, res) => {
  const query = z.strictObject({ view: z.enum(['mine', 'inbox', 'decided']).default('mine'), page: z.coerce.number().int().min(1).max(10_000).default(1) }).parse(req.query);
  res.json(await listCorrections(contextOf(req), query.view, query.page));
});

correctionRoutes.post('/', async (req, res) => {
  res.status(201).json(await submitCorrection(contextOf(req), input.parse(req.body)));
});

correctionRoutes.post('/:id/cancel', async (req, res) => {
  z.strictObject({}).parse(req.body ?? {});
  res.json(await cancelCorrection(contextOf(req), id.parse(req.params.id)));
});

/** `dayVersion` is the version of the day the approver was shown. A day that has changed since is not corrected blind. */
correctionRoutes.post('/:id/approve', async (req, res) => {
  const body = z.strictObject({ dayVersion: z.number().int().min(0), note: text(REASON_MAX) }).parse(req.body);
  res.json(await approveCorrection(contextOf(req), id.parse(req.params.id), body.dayVersion, body.note));
});

correctionRoutes.post('/:id/reject', async (req, res) => {
  const body = z.strictObject({ note: text(REASON_MAX).min(1, 'Say why the request is rejected.') }).parse(req.body);
  res.json(await rejectCorrection(contextOf(req), id.parse(req.params.id), body.note));
});
