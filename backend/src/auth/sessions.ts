import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { config } from '../config';
import { db, type SessionDoc } from '../db';

/*
 * Sessions live in MongoDB, not in the cookie. The cookie carries only a random token; the
 * database stores its hash. That means a session can be ended from the server (sign-out,
 * deactivation, a password change) and nothing about it can be changed by the browser.
 *
 * Sessions run on the real clock, not the HRMS clock the tests can set: when a session ends
 * is not an attendance fact.
 */

/** Not `delta_session`: cookies are shared between ports on one host, and the CRM uses that name. */
export const SESSION_COOKIE = 'delta_hrms_session';
const HOUR = 3_600_000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  path: '/',
} as const;

/** Starts a session and sets its cookie. "Remember me" keeps it for days; otherwise it lasts 12 hours and ends with the browser. */
export async function createSession(res: Response, employeeId: string, remember: boolean) {
  const token = randomBytes(32).toString('base64url');
  const lifetime = remember ? config.sessionDays * 24 * HOUR : 12 * HOUR;
  const now = new Date();
  await db().sessions.insertOne({
    _id: hashToken(token),
    employeeId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + lifetime),
  });
  res.cookie(SESSION_COOKIE, token, remember ? { ...cookieOptions, maxAge: lifetime } : cookieOptions);
}

export function findSession(token: string): Promise<SessionDoc | null> {
  return db().sessions.findOne({ _id: hashToken(token), expiresAt: { $gt: new Date() } });
}

export async function destroySession(res: Response, sessionId: string) {
  await db().sessions.deleteOne({ _id: sessionId });
  res.clearCookie(SESSION_COOKIE, cookieOptions);
}

/** Ends every session of the given people, e.g. when they are deactivated or their password is reset. */
export async function revokeSessionsOf(employeeIds: string[]) {
  if (employeeIds.length > 0) await db().sessions.deleteMany({ employeeId: { $in: employeeIds } });
}
