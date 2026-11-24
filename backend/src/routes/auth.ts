import { Router } from 'express';
import { z } from 'zod';
import { validateCompany, type CompanySettings, type MetaPayload } from '@delta-hrms/shared';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/passwords';
import { createSession, destroySession, findSession, SESSION_COOKIE } from '../auth/sessions';
import { clock } from '../clock';
import { config } from '../config';
import { db, isDuplicateKey, toDoc, type Account } from '../db';
import { conflict, forbidden, unauthorized, unprocessable } from '../http/errors';
import { email, password, personName, required } from '../http/schemas';
import { loginLimiter } from '../http/security';
import { newId } from '../ids';
import { addAdmin } from '../services/admins';
import { recordAudit } from '../services/audit';
import { FIRST_EMPLOYEE_CODE, reserveEmployeeCodes } from '../services/employees';
import { saveCompany } from '../services/settings';
import { sameSecret, setupGate } from '../services/setup';

/** The only routes that work without being signed in. Everything else is behind `authenticate` (see app.ts). */
export const publicRoutes = Router();

const ALREADY_SET_UP = 'This HRMS has already been set up. Sign in instead.';

publicRoutes.get('/meta', async (_req, res) => {
  const gate = setupGate(config);
  const meta: MetaPayload = {
    setupNeeded: (await db().employees.estimatedDocumentCount()) === 0,
    setupCodeRequired: gate === 'code',
    setupAvailable: gate !== 'disabled',
  };
  res.json(meta);
});

/**
 * First-run setup: creates the company and its first Admin. It works exactly once. What makes
 * that true is not the count below (two requests could both pass it) but the insert: the
 * first Admin always takes the code EMP-0001, and the database holds one of each code.
 */
publicRoutes.post('/setup', async (req, res) => {
  const input = z
    .strictObject({
      companyName: required(200, 'Please enter the company name.'),
      timeZone: z.string().max(80),
      name: personName,
      email,
      password,
      setupCode: z.string().max(200).optional(),
    })
    .parse(req.body);

  const gate = setupGate(config);
  if (gate === 'disabled') throw forbidden('Setup is switched off on this server until a setup code is set. See backend/.env.example.');
  // Guessing the setup code is slowed down the same way as guessing a password.
  const attemptKey = `setup|${req.ip}`;
  loginLimiter.attempt(attemptKey);
  if ((await db().employees.estimatedDocumentCount()) > 0) throw conflict(ALREADY_SET_UP);
  if (gate === 'code' && !sameSecret(input.setupCode ?? '', config.setupCode!)) throw forbidden('That setup code is not right.');

  const company: CompanySettings = { name: input.companyName, timeZone: input.timeZone, weekStartsOn: 'monday', leaveYearStartMonth: 1 };
  const problems = validateCompany(company);
  if (Object.keys(problems).length > 0) {
    const fields = Object.fromEntries(Object.entries(problems).map(([field, message]) => [field === 'name' ? 'companyName' : field, message]));
    throw unprocessable(Object.values(problems)[0]!, fields);
  }

  const now = clock.nowIso();
  const admin: Account = {
    id: newId('emp'),
    code: FIRST_EMPLOYEE_CODE,
    name: input.name,
    email: input.email,
    phone: '',
    role: 'Admin',
    departmentId: null,
    designation: '',
    managerId: null,
    joinDate: null,
    employment: [],
    status: 'active',
    leavePolicyId: null,
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
    passwordHash: await hashPassword(input.password),
  };
  try {
    await db().employees.insertOne(toDoc(admin));
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(ALREADY_SET_UP);
    throw error;
  }
  // Only the winner of that insert gets here, so these cannot overwrite someone else's setup.
  await saveCompany(company);
  await addAdmin(admin.id);
  await reserveEmployeeCodes(1);
  await recordAudit({ employee: admin, ip: req.ip }, { action: 'setup.completed', targetType: 'company', summary: `Set up ${company.name} and created its first Admin.`, after: company });
  loginLimiter.succeed(attemptKey);
  await createSession(res, admin.id, true);
  res.status(204).end();
});

publicRoutes.post('/auth/login', async (req, res) => {
  const input = z.strictObject({ email, password: z.string().max(200), remember: z.boolean().default(true) }).parse(req.body);
  const key = `${req.ip}|${input.email}`;
  loginLimiter.attempt(key);

  const doc = await db().employees.findOne({ email: input.email });
  // Always run the slow comparison, so an unknown email takes as long as a wrong password.
  const matches = await verifyPassword(input.password, doc?.passwordHash ?? DUMMY_HASH);
  if (!doc || !matches) throw unauthorized('That email and password do not match an account.');
  if (doc.status === 'inactive') throw forbidden('This account has been deactivated. Ask HR to restore access.');

  loginLimiter.succeed(key);
  // First sign-in turns an invited account into an active one.
  await db().employees.updateOne({ _id: doc._id }, { $set: { status: 'active', lastLoginAt: clock.nowIso() } });
  await createSession(res, doc._id, input.remember);
  res.status(204).end();
});

publicRoutes.post('/auth/logout', async (req, res) => {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  const session = typeof token === 'string' && token ? await findSession(token) : null;
  if (session) await destroySession(res, session._id);
  res.status(204).end();
});
