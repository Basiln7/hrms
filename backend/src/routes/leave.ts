import { Router } from 'express';
import { z } from 'zod';
import { HOLIDAY_YEAR_MAX, HOLIDAY_YEAR_MIN, LEAVE_PARTS, LEAVE_TONES, REASON_MAX, type LeavePart } from '@delta-hrms/shared';
import { contextOf, requirePermission } from '../http/context';
import { id, idList, text } from '../http/schemas';
import { approveLeave, cancelLeave, listLeave, previewLeave, rejectLeave, submitLeave } from '../services/leave';
import { adjustLeave, balancesFor } from '../services/leaveAccounts';
import { assignPolicy, createLeavePolicy, createLeaveType, deleteLeavePolicy, leaveSetup, makeDefaultPolicy, updateLeavePolicy, updateLeaveType } from '../services/leaveSetup';
import { loadLeaveTypes } from '../services/leaveStore';

/*
 * Leave. Three routers:
 * - the kinds of leave, which everyone may read and HR sets up;
 * - the policies and who is on them, which is all HR's (\`leave.configure\`);
 * - balances and requests, where everyone acts for themselves and the services decide, on
 *   every call, whose account or request the caller may see or decide.
 *
 * Only shapes are checked here. Whether a kind of leave, a policy or a request makes sense is
 * decided by the shared rules, the same code the forms run.
 */

const typeFields = { name: z.string().max(200), code: z.string().max(20), paid: z.boolean(), allowHalfDay: z.boolean(), tone: z.enum(LEAVE_TONES) };

export const leaveTypeRoutes = Router();

leaveTypeRoutes.get('/', async (_req, res) => {
  res.json(await loadLeaveTypes());
});

leaveTypeRoutes.post('/', requirePermission('leave.configure'), async (req, res) => {
  res.status(201).json(await createLeaveType(contextOf(req), z.strictObject(typeFields).parse(req.body)));
});

leaveTypeRoutes.patch('/:id', requirePermission('leave.configure'), async (req, res) => {
  res.json(await updateLeaveType(contextOf(req), id.parse(req.params.id), z.strictObject({ ...typeFields, archived: z.boolean() }).parse(req.body)));
});

const policyEntry = z.strictObject({
  leaveTypeId: id,
  annualDays: z.number(),
  prorateFirstYear: z.boolean(),
  carryForwardMax: z.number(),
  eligibleAfterDays: z.number(),
  maxConsecutiveDays: z.number().nullable(),
  minNoticeDays: z.number(),
  backdateDays: z.number(),
  allowNegative: z.boolean(),
});
const policyInput = z.strictObject({ name: z.string().max(200), approver: z.enum(['manager', 'hr']), entries: z.array(policyEntry).max(100) });

/** Leave policies, and who is on which: all of it needs \`leave.configure\`. */
export const leavePolicyRoutes = Router();
leavePolicyRoutes.use(requirePermission('leave.configure'));

leavePolicyRoutes.get('/', async (_req, res) => {
  res.json(await leaveSetup());
});

leavePolicyRoutes.post('/', async (req, res) => {
  res.status(201).json(await createLeavePolicy(contextOf(req), policyInput.parse(req.body)));
});

/** Puts people on a policy, or on none. Before \`/:id\` so that "assign" is never read as an id. */
leavePolicyRoutes.post('/assign', async (req, res) => {
  res.json(await assignPolicy(contextOf(req), z.strictObject({ policyId: id.nullable(), employeeIds: idList }).parse(req.body)));
});

leavePolicyRoutes.patch('/:id', async (req, res) => {
  res.json(await updateLeavePolicy(contextOf(req), id.parse(req.params.id), policyInput.parse(req.body)));
});

leavePolicyRoutes.delete('/:id', async (req, res) => {
  await deleteLeavePolicy(contextOf(req), id.parse(req.params.id));
  res.status(204).end();
});

leavePolicyRoutes.post('/:id/default', async (req, res) => {
  z.strictObject({}).parse(req.body ?? {});
  await makeDefaultPolicy(contextOf(req), id.parse(req.params.id));
  res.status(204).end();
});

const leaveYear = z.coerce.number().int().min(HOLIDAY_YEAR_MIN).max(HOLIDAY_YEAR_MAX);
// A half-filled form is sent here for its preview, so the fields are only held to a size.
const requestFields = { leaveTypeId: z.string().max(60), startDate: z.string().max(10), endDate: z.string().max(10), dayPart: z.enum(LEAVE_PARTS as [LeavePart, ...LeavePart[]]) };

export const leaveRoutes = Router();

/** One person's leave account for a leave year: the caller's own, or anyone they may see. */
leaveRoutes.get('/balances', async (req, res) => {
  const ctx = contextOf(req);
  const query = z.strictObject({ employeeId: id.optional(), year: leaveYear.optional() }).parse(req.query);
  res.json(await balancesFor(ctx, query.employeeId ?? ctx.employee.id, query.year));
});

leaveRoutes.post('/adjustments', requirePermission('leave.configure'), async (req, res) => {
  const input = z.strictObject({ employeeId: id, leaveYear: z.number().int().min(HOLIDAY_YEAR_MIN).max(HOLIDAY_YEAR_MAX), leaveTypeId: id, days: z.number(), note: z.string().max(REASON_MAX * 2) }).parse(req.body);
  res.status(201).json(await adjustLeave(contextOf(req), input));
});

leaveRoutes.get('/requests', async (req, res) => {
  const query = z.strictObject({ view: z.enum(['mine', 'inbox', 'decided', 'person']).default('mine'), page: z.coerce.number().int().min(1).max(10_000).default(1), employeeId: id.optional() }).parse(req.query);
  res.json(await listLeave(contextOf(req), query.view, query.page, query.employeeId));
});

/** What a request would use and leave. It is the caller's own request: there is no employee to name. */
leaveRoutes.post('/requests/preview', async (req, res) => {
  res.json(await previewLeave(contextOf(req), z.strictObject(requestFields).parse(req.body)));
});

leaveRoutes.post('/requests', async (req, res) => {
  res.status(201).json(await submitLeave(contextOf(req), z.strictObject({ ...requestFields, reason: z.string().max(REASON_MAX * 2) }).parse(req.body)));
});

leaveRoutes.post('/requests/:id/cancel', async (req, res) => {
  const body = z.strictObject({ reason: text(REASON_MAX).optional() }).parse(req.body ?? {});
  res.json(await cancelLeave(contextOf(req), id.parse(req.params.id), body.reason ?? ''));
});

leaveRoutes.post('/requests/:id/approve', async (req, res) => {
  const body = z.strictObject({ note: text(REASON_MAX) }).parse(req.body);
  res.json(await approveLeave(contextOf(req), id.parse(req.params.id), body.note));
});

leaveRoutes.post('/requests/:id/reject', async (req, res) => {
  const body = z.strictObject({ note: text(REASON_MAX).min(1, 'Say why the request is rejected.') }).parse(req.body);
  res.json(await rejectLeave(contextOf(req), id.parse(req.params.id), body.note));
});
