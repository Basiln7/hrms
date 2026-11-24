import { Router } from 'express';
import { z } from 'zod';
import { permissionsOf, type MePayload } from '@delta-hrms/shared';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { clock } from '../clock';
import { db } from '../db';
import { contextOf } from '../http/context';
import { badRequest, forbidden } from '../http/errors';
import { password, phone } from '../http/schemas';
import { loginLimiter } from '../http/security';
import { unreadFor } from '../services/announcements';
import { approvalsWaiting as approvalsWaitingFor } from '../services/approvals';
import { toSelf } from '../services/employees';
import { currentScheduleNames } from '../services/schedules';
import { loadCompany } from '../services/settings';

/** Routes about the signed-in person. "Me" is always the session's owner; no id is taken from the request. */
export const meRoutes = Router();

meRoutes.get('/me', async (req, res) => {
  const ctx = contextOf(req);
  // Someone still on a temporary password decides nothing yet, and is told nothing about what waits.
  const quiet = ctx.employee.mustChangePassword;
  const [employee, company, schedules, approvalsWaiting, unreadAnnouncements] = await Promise.all([toSelf(ctx.employee), loadCompany(), currentScheduleNames([ctx.employee.id]), quiet ? 0 : approvalsWaitingFor(ctx.employee), quiet ? 0 : unreadFor(ctx.employee)]);
  const payload: MePayload = {
    employee,
    permissions: permissionsOf(ctx.employee.role),
    company,
    scheduleName: schedules.get(ctx.employee.id) ?? null,
    serverNow: clock.nowIso(),
    approvalsWaiting,
    unreadAnnouncements,
  };
  res.json(payload);
});

/** People keep their own phone number up to date. Name, email, role and the rest are HR's to change. */
meRoutes.patch('/me/profile', async (req, res) => {
  const ctx = contextOf(req);
  const input = z.strictObject({ phone }).parse(req.body);
  await db().employees.updateOne({ _id: ctx.employee.id }, { $set: { phone: input.phone, updatedAt: clock.nowIso() } });
  res.status(204).end();
});

meRoutes.post('/me/password', async (req, res) => {
  const ctx = contextOf(req);
  const input = z.strictObject({ current: z.string().max(200), next: password }).parse(req.body);
  // A session left open on a shared computer is not a way to find out the password by trying.
  const attemptKey = `password|${ctx.employee.id}`;
  loginLimiter.attempt(attemptKey);
  if (!(await verifyPassword(input.current, ctx.employee.passwordHash))) throw forbidden('Your current password is not correct.');
  loginLimiter.succeed(attemptKey);
  if (input.next === input.current) throw badRequest('Choose a password different from the current one.', { next: 'Choose a password different from the current one.' });

  await db().employees.updateOne(
    { _id: ctx.employee.id },
    { $set: { passwordHash: await hashPassword(input.next), mustChangePassword: false, updatedAt: clock.nowIso() } },
  );
  // Any other device still signed in with the old password is signed out.
  await db().sessions.deleteMany({ employeeId: ctx.employee.id, _id: { $ne: ctx.session._id } });
  res.status(204).end();
});
