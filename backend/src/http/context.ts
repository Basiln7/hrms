import type { NextFunction, Request, Response } from 'express';
import { can, PASSWORD_CHANGE_REQUIRED, type PermissionId } from '@delta-hrms/shared';
import { destroySession, findSession, SESSION_COOKIE } from '../auth/sessions';
import { db, fromDoc, type Account, type SessionDoc } from '../db';
import { forbidden, unauthorized } from './errors';

/** Who is making this request, worked out once per request by `authenticate`. */
export interface RequestContext {
  /** The signed-in person. "Me" always comes from here, never from the request. */
  employee: Account;
  session: SessionDoc;
  /** Whether the signed-in person's role holds a permission. */
  can: (permission: PermissionId) => boolean;
  /** Where the request came from, for the audit log. */
  ip: string;
}

const contexts = new WeakMap<Request, RequestContext>();

/** The context of an authenticated request. Throws if the route is not behind `authenticate`. */
export function contextOf(req: Request): RequestContext {
  const ctx = contexts.get(req);
  if (!ctx) throw unauthorized();
  return ctx;
}

/** All that someone still holding a temporary password may do: see who they are, and choose a new one. */
const ALLOWED_WITH_TEMPORARY_PASSWORD = new Set(['GET /me', 'POST /me/password']);

/**
 * Requires a valid session. Everything is re-read on every request, so deactivating someone
 * or changing their role takes effect on their very next click.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  const session = typeof token === 'string' && token ? await findSession(token) : null;
  if (!session) throw unauthorized();

  const doc = await db().employees.findOne({ _id: session.employeeId });
  if (!doc || doc.status === 'inactive') {
    await destroySession(res, session._id);
    throw unauthorized();
  }
  const employee = fromDoc<Account>(doc);
  if (employee.mustChangePassword && !ALLOWED_WITH_TEMPORARY_PASSWORD.has(`${req.method} ${req.path}`)) {
    throw forbidden('Choose a new password before going on.', PASSWORD_CHANGE_REQUIRED);
  }

  contexts.set(req, {
    employee,
    session,
    can: (permission) => can(employee.role, permission),
    ip: req.ip ?? '',
  });
  next();
}

/**
 * Route guard: the signed-in person must hold this permission.
 *
 * The guard carries the name of the permission it checks, so that the QA sweep can read what
 * every route declares and then check, role by role, that the route really enforces it.
 */
export function requirePermission(permission: PermissionId, message?: string) {
  const guard = (req: Request, _res: Response, next: NextFunction) => {
    if (!contextOf(req).can(permission)) throw forbidden(message);
    next();
  };
  return Object.assign(guard, { permission });
}
