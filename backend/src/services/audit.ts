import { addDays, AUDIT_AREA_INFO, startOfDay, type AuditArea, type AuditEvent, type AuditListPayload, type LocalDate } from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, fromDoc, toDoc, type Account } from '../db';
import { newId } from '../ids';
import { loadCompany } from './settings';

/*
 * The audit log: one row for every HR or admin action. Rows are only ever added. There is
 * no function here, and no route anywhere, that changes or removes one.
 */

export interface AuditInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  /** The employee the action concerns, when it concerns one. */
  employeeId?: string | null;
  /** One line a person can read. */
  summary: string;
  before?: unknown;
  after?: unknown;
  selfAdministered?: boolean;
}

/** Who did it and from where. `null` for something the system did by itself. */
export type AuditBy = { employee: Pick<Account, 'id' | 'name' | 'role'>; ip?: string } | null;

const toEvent = (by: AuditBy, input: AuditInput, at: string): AuditEvent => ({
  id: newId('aud'),
  at,
  actor: by ? { id: by.employee.id, name: by.employee.name, role: by.employee.role } : null,
  action: input.action,
  targetType: input.targetType,
  targetId: input.targetId ?? null,
  employeeId: input.employeeId ?? null,
  summary: input.summary,
  before: input.before,
  after: input.after,
  selfAdministered: input.selfAdministered || undefined,
  ip: by?.ip || undefined,
});

export async function recordAudit(by: AuditBy, input: AuditInput) {
  await db().audit.insertOne(toDoc(toEvent(by, input, clock.nowIso())));
}

/** One row per person for an action that touched many, so the log can be read person by person. */
export async function recordAudits(by: AuditBy, inputs: readonly AuditInput[]) {
  if (inputs.length === 0) return;
  const at = clock.nowIso();
  await db().audit.insertMany(inputs.map((input) => toDoc(toEvent(by, input, at))));
}

export const AUDIT_PAGE = 50;

export interface AuditFilter {
  area?: AuditArea;
  /** Who did it. */
  actorId?: string;
  /** Whom it concerns. */
  employeeId?: string;
  from?: LocalDate;
  to?: LocalDate;
  /** Words from the one-line summary. */
  search?: string;
  page: number;
}

/** Search text as a pattern that matches it literally: what someone types is never read as a pattern. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The log, newest first, narrowed by what is asked for. Dates are days on the company's clock. Reading it writes nothing. */
export async function listAudit(filter: AuditFilter): Promise<AuditListPayload> {
  const company = await loadCompany();
  const query: Record<string, unknown> = {};
  // The prefixes are this code's own words, never the caller's.
  // Every action that starts "<prefix>." — asked as a range ("/" is the character after "."), which the index answers directly.
  if (filter.area) query.$or = AUDIT_AREA_INFO[filter.area].prefixes.map((prefix) => ({ action: { $gte: `${prefix}.`, $lt: `${prefix}/` } }));
  if (filter.actorId) query['actor.id'] = filter.actorId;
  if (filter.employeeId) query.employeeId = filter.employeeId;
  if (filter.from || filter.to) {
    query.at = {
      ...(filter.from ? { $gte: startOfDay(filter.from, company.timeZone).toISOString() } : {}),
      ...(filter.to ? { $lt: startOfDay(addDays(filter.to, 1), company.timeZone).toISOString() } : {}),
    };
  }
  if (filter.search) query.summary = { $regex: literally(filter.search), $options: 'i' };

  const [total, docs, everyActor] = await Promise.all([
    db().audit.countDocuments(query),
    db()
      .audit.find(query)
      .sort({ at: -1, _id: -1 })
      .skip((filter.page - 1) * AUDIT_PAGE)
      .limit(AUDIT_PAGE)
      .toArray(),
    // Everyone who has ever done something, for the filter: read from the index, not from the log.
    // Asked without a condition, so that it is answered by walking the index's distinct values.
    db().audit.distinct('actor.id') as Promise<unknown[]>,
  ]);
  const actors = everyActor.filter((id): id is string => typeof id === 'string');
  // People are never removed, so a name is always there to be read; it is the name they have today.
  const about = [...new Set([...actors, ...docs.map((doc) => doc.employeeId).filter((id): id is string => Boolean(id))])];
  const names = new Map((about.length === 0 ? [] : await db().employees.find({ _id: { $in: about } }, { projection: { name: 1 } }).toArray()).map((e) => [e._id, e.name]));
  return {
    items: docs.map((doc) => ({ ...fromDoc<AuditEvent>(doc), employeeName: (doc.employeeId && names.get(doc.employeeId)) || null })),
    total,
    page: filter.page,
    pageSize: AUDIT_PAGE,
    actors: actors.map((id) => ({ id, name: names.get(id) ?? 'Someone' })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    timeZone: company.timeZone,
  };
}
