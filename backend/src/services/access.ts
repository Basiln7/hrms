import { inScope, OWN_RECORD_MESSAGE, ownRecordVerdict, scopeOf, type OrgNode, type Scope } from '@delta-hrms/shared';
import { db } from '../db';
import type { RequestContext } from '../http/context';
import { forbidden, notFound } from '../http/errors';

/*
 * Who may see whom, and the rule that nobody uses an HR power on their own record. The
 * decisions are made by the shared functions; this file only fetches what they need. Every
 * route that names an employee goes through here.
 */

/** Everyone, reduced to what scope maths needs. */
export async function loadOrg(): Promise<OrgNode[]> {
  const docs = await db().employees.find({}, { projection: { role: 1, managerId: 1, status: 1 } }).toArray();
  return docs.map((d) => ({ id: d._id, role: d.role, managerId: d.managerId, status: d.status }));
}

/** Who the signed-in person may see. */
export async function scopeFor(ctx: RequestContext, org?: readonly OrgNode[]): Promise<Scope> {
  // An Employee's scope is themselves whatever the organisation looks like: no need to load it.
  if (!ctx.can('employees.viewAll') && !ctx.can('team.view')) return { kind: 'self', self: ctx.employee.id };
  return scopeOf(ctx.employee, org ?? (await loadOrg()));
}

/**
 * Refuses a request about someone the signed-in person may not see. The answer is "not
 * found", exactly as for an id that does not exist, so ids cannot be probed.
 */
export async function assertInScope(ctx: RequestContext, employeeId: string, org?: readonly OrgNode[]) {
  if (!inScope(await scopeFor(ctx, org), employeeId)) throw notFound('That person does not exist.');
}

/**
 * Refuses an HR action that touches the person doing it, unless they are the only HR or
 * Admin in the company. Returns whether that exception was used, for the audit log.
 */
export async function guardOwnRecord(ctx: RequestContext, targetIds: readonly string[], org?: readonly OrgNode[]): Promise<{ selfAdministered: boolean }> {
  if (!targetIds.includes(ctx.employee.id)) return { selfAdministered: false };
  const verdict = ownRecordVerdict(ctx.employee, targetIds, org ?? (await loadOrg()));
  if (verdict === 'blocked') throw forbidden(OWN_RECORD_MESSAGE);
  return { selfAdministered: verdict === 'self_administered' };
}
