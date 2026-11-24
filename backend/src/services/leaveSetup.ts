import { leaveYearLabel, leaveYearOf, localDateOf, OWN_RECORD_MESSAGE, ownRecordVerdict, validateLeavePolicy, validateLeaveType, type AssignmentResult, type LeavePolicy, type LeavePolicyInput, type LeavePolicyRow, type LeaveSetupPayload, type LeaveType, type LeaveTypeInput, type PolicyAssignInput, type PolicyEntry } from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, isDuplicateKey, nameKey, toDoc } from '../db';
import type { RequestContext } from '../http/context';
import { conflict, notFound, unprocessable } from '../http/errors';
import { newId } from '../ids';
import { loadOrg } from './access';
import { recordAudit, recordAudits, type AuditInput } from './audit';
import { openAccount, toPolicy } from './leaveAccounts';
import { defaultPolicyId, loadLeaveTypes, saveDefaultPolicy, toLeaveType } from './leaveStore';
import { loadCompany } from './settings';

/*
 * Setting leave up: the kinds of leave, the policies, and who is on which policy.
 *
 * Nothing here reaches into an account. A policy edited today changes what is granted from
 * now on; a grant already made stays as it was, and HR corrects a balance with an adjustment
 * that carries its reason (plan.md, 7.1).
 */

const firstProblem = (problems: Record<string, string>) => Object.values(problems)[0]!;

/** Which unique key a refused write ran into. */
const collidedOn = (error: unknown, field: string) => Boolean((error as { keyPattern?: Record<string, unknown> }).keyPattern?.[field]);

function soundType(raw: LeaveTypeInput): LeaveTypeInput {
  const input: LeaveTypeInput = { name: raw.name.trim().replace(/\s+/g, ' '), code: raw.code.trim().toUpperCase(), paid: raw.paid, allowHalfDay: raw.allowHalfDay, tone: raw.tone };
  const problems = validateLeaveType(input);
  if (Object.keys(problems).length > 0) throw unprocessable(firstProblem(problems), problems);
  return input;
}

function typeTaken(error: unknown) {
  const field = collidedOn(error, 'code') ? 'code' : 'name';
  const message = field === 'code' ? 'Another kind of leave already has that code.' : 'Another kind of leave already has that name.';
  return unprocessable(message, { [field]: message });
}

export async function createLeaveType(ctx: RequestContext, raw: LeaveTypeInput): Promise<LeaveType> {
  const input = soundType(raw);
  const now = clock.nowIso();
  const type: LeaveType = { id: newId('lvt'), ...input, archived: false, createdAt: now, updatedAt: now };
  try {
    await db().leaveTypes.insertOne({ ...toDoc(type), nameKey: nameKey(type.name) });
  } catch (error) {
    if (isDuplicateKey(error)) throw typeTaken(error);
    throw error;
  }
  await recordAudit(ctx, { action: 'leave_type.created', targetType: 'leave_type', targetId: type.id, summary: `Added the kind of leave "${type.name}" (${type.code}, ${type.paid ? 'paid' : 'unpaid'}).`, after: input });
  return type;
}

export async function updateLeaveType(ctx: RequestContext, id: string, raw: LeaveTypeInput & { archived: boolean }): Promise<LeaveType> {
  const doc = await db().leaveTypes.findOne({ _id: id });
  if (!doc) throw notFound('That kind of leave no longer exists.');
  const existing = toLeaveType(doc);
  const input = soundType(raw);
  // Paid or unpaid decides how leave already taken is counted, so it is fixed once the kind has been used.
  if (input.paid !== existing.paid && (await db().leaveRequests.countDocuments({ leaveTypeId: id }, { limit: 1 })) > 0) {
    const message = `${existing.name} has already been asked for, and whether it is paid decides how that leave is counted. Archive it and add a new kind instead.`;
    throw unprocessable(message, { paid: message });
  }
  const updated: LeaveType = { ...existing, ...input, archived: raw.archived, updatedAt: clock.nowIso() };
  try {
    await db().leaveTypes.updateOne({ _id: id }, { $set: { ...input, archived: raw.archived, nameKey: nameKey(input.name), updatedAt: updated.updatedAt } });
  } catch (error) {
    if (isDuplicateKey(error)) throw typeTaken(error);
    throw error;
  }
  const was = { name: existing.name, code: existing.code, paid: existing.paid, allowHalfDay: existing.allowHalfDay, tone: existing.tone, archived: existing.archived };
  const action = raw.archived !== existing.archived ? (raw.archived ? 'leave_type.archived' : 'leave_type.restored') : 'leave_type.updated';
  const summary = raw.archived !== existing.archived ? `${raw.archived ? 'Archived' : 'Restored'} the kind of leave "${updated.name}".${raw.archived ? ' Leave already booked under it stays as it is.' : ''}` : `Changed the kind of leave "${existing.name}".`;
  await recordAudit(ctx, { action, targetType: 'leave_type', targetId: id, summary, before: was, after: { ...input, archived: raw.archived } });
  return updated;
}

async function requirePolicy(id: string): Promise<LeavePolicy> {
  const doc = await db().leavePolicies.findOne({ _id: id });
  if (!doc) throw notFound('That leave policy no longer exists.');
  return toPolicy(doc);
}

const POLICY_NAME_TAKEN = 'Another leave policy already has that name.';

/** A policy as it is stored: checked against the kinds of leave that exist, with nothing in it but what a policy has. */
async function soundPolicy(raw: LeavePolicyInput): Promise<LeavePolicyInput> {
  const types = await loadLeaveTypes();
  const order = new Map(types.map((type, index) => [type.id, index]));
  const entries: PolicyEntry[] = raw.entries
    .map((e) => ({ leaveTypeId: e.leaveTypeId, annualDays: e.annualDays, prorateFirstYear: e.prorateFirstYear, carryForwardMax: e.carryForwardMax, eligibleAfterDays: e.eligibleAfterDays, maxConsecutiveDays: e.maxConsecutiveDays, minNoticeDays: e.minNoticeDays, backdateDays: e.backdateDays, allowNegative: e.allowNegative }))
    .sort((a, b) => (order.get(a.leaveTypeId) ?? 0) - (order.get(b.leaveTypeId) ?? 0));
  const input: LeavePolicyInput = { name: raw.name.trim().replace(/\s+/g, ' '), approver: raw.approver, entries };
  const problems = validateLeavePolicy(input, types);
  if (Object.keys(problems).length > 0) throw unprocessable(firstProblem(problems), problems);
  return input;
}

export async function createLeavePolicy(ctx: RequestContext, raw: LeavePolicyInput): Promise<LeavePolicy> {
  const input = await soundPolicy(raw);
  const now = clock.nowIso();
  const policy: LeavePolicy = { id: newId('lvp'), ...input, createdAt: now, updatedAt: now };
  try {
    await db().leavePolicies.insertOne({ ...toDoc(policy), nameKey: nameKey(policy.name) });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(POLICY_NAME_TAKEN, { name: POLICY_NAME_TAKEN });
    throw error;
  }
  // The first policy becomes the one new people are put on. It can be changed afterwards.
  const becameDefault = (await defaultPolicyId()) === null;
  if (becameDefault) await saveDefaultPolicy(policy.id);
  await recordAudit(ctx, { action: 'leave_policy.created', targetType: 'leave_policy', targetId: policy.id, summary: `Created the leave policy "${policy.name}"${becameDefault ? ', which became the one new people are put on' : ''}.`, after: input });
  return policy;
}

export async function updateLeavePolicy(ctx: RequestContext, id: string, raw: LeavePolicyInput): Promise<LeavePolicy> {
  const existing = await requirePolicy(id);
  const input = await soundPolicy(raw);
  const updatedAt = clock.nowIso();
  try {
    await db().leavePolicies.updateOne({ _id: id }, { $set: { ...input, nameKey: nameKey(input.name), updatedAt } });
  } catch (error) {
    if (isDuplicateKey(error)) throw unprocessable(POLICY_NAME_TAKEN, { name: POLICY_NAME_TAKEN });
    throw error;
  }
  await recordAudit(ctx, {
    action: 'leave_policy.updated',
    targetType: 'leave_policy',
    targetId: id,
    summary: `Changed the leave policy "${existing.name}". It applies to what is granted and asked for from now on; allowances already granted stay as they are.`,
    before: { name: existing.name, approver: existing.approver, entries: existing.entries },
    after: input,
  });
  return { ...existing, ...input, updatedAt };
}

/** Deletes a policy nobody is on. */
export async function deleteLeavePolicy(ctx: RequestContext, id: string) {
  const policy = await requirePolicy(id);
  const people = await db().employees.countDocuments({ leavePolicyId: id });
  if (people > 0) throw conflict(`${people} ${people === 1 ? 'person is' : 'people are'} on "${policy.name}". Move them to another policy first.`);
  await db().leavePolicies.deleteOne({ _id: id });
  if ((await defaultPolicyId()) === id) await saveDefaultPolicy(null);
  await recordAudit(ctx, { action: 'leave_policy.deleted', targetType: 'leave_policy', targetId: id, summary: `Deleted the leave policy "${policy.name}", which nobody was on.`, before: { name: policy.name, approver: policy.approver, entries: policy.entries } });
}

/** Makes a policy the one people are put on as they are added. Nobody already here is changed. */
export async function makeDefaultPolicy(ctx: RequestContext, id: string) {
  const policy = await requirePolicy(id);
  const before = await defaultPolicyId();
  if (before === id) return;
  await saveDefaultPolicy(id);
  await recordAudit(ctx, { action: 'leave_policy.made_default', targetType: 'leave_policy', targetId: id, summary: `Made "${policy.name}" the leave policy new people are put on. Nobody's own policy was changed by this.`, before: { defaultPolicyId: before }, after: { defaultPolicyId: id } });
}

/** Everything the leave setup page shows. */
export async function leaveSetup(): Promise<LeaveSetupPayload> {
  const [types, policies, defaultId, counts, withoutPolicy, company] = await Promise.all([
    loadLeaveTypes(),
    db().leavePolicies.find().sort({ nameKey: 1 }).toArray(),
    defaultPolicyId(),
    db()
      .employees.aggregate<{ _id: string | null; count: number }>([{ $match: { status: { $ne: 'inactive' } } }, { $group: { _id: '$leavePolicyId', count: { $sum: 1 } } }])
      .toArray(),
    db().employees.countDocuments({ status: { $ne: 'inactive' }, leavePolicyId: null }),
    loadCompany(),
  ]);
  const countOf = new Map(counts.map((c) => [c._id, c.count]));
  const rows: LeavePolicyRow[] = policies.map((doc) => ({ ...toPolicy(doc), isDefault: doc._id === defaultId, peopleCount: countOf.get(doc._id) ?? 0 }));
  const today = localDateOf(clock.now(), company.timeZone);
  return { types, policies: rows, withoutPolicy, yearLabel: leaveYearLabel(leaveYearOf(today, company.leaveYearStartMonth), company.leaveYearStartMonth) };
}

/**
 * Puts one or many people on a leave policy, or on none. Each person is judged on their own,
 * and the answer says who was moved and, for everyone else, why not. HR is never moved by
 * their own hand (plan.md, D13).
 *
 * The account of the current leave year is opened in the same step, so the year's allowance
 * is granted under the policy as it is today. Someone moved from another policy keeps what
 * they were granted; only kinds of leave they had no allowance for yet are granted now.
 */
export async function assignPolicy(ctx: RequestContext, input: PolicyAssignInput): Promise<AssignmentResult> {
  const policy = input.policyId ? await requirePolicy(input.policyId) : null;
  const inWords = policy ? `the leave policy "${policy.name}"` : 'no leave policy';
  const ids = [...new Set(input.employeeIds)];
  const [people, everyone] = await Promise.all([db().employees.find({ _id: { $in: ids } }).toArray(), loadOrg()]);
  const byId = new Map(people.map((p) => [p._id, p]));
  const ownRecord = ownRecordVerdict(ctx.employee, ids, everyone);
  const result: AssignmentResult = { assigned: [], skipped: [] };
  const audits: AuditInput[] = [];

  for (const id of ids) {
    const person = byId.get(id);
    if (!person) {
      result.skipped.push({ employeeId: id, name: '', reason: 'That person no longer exists.' });
      continue;
    }
    const skip = (reason: string) => result.skipped.push({ employeeId: id, name: person.name, reason });
    if (id === ctx.employee.id && ownRecord === 'blocked') {
      skip(OWN_RECORD_MESSAGE);
      continue;
    }
    if (person.status === 'inactive') {
      skip('They are deactivated. Reactivate them first.');
      continue;
    }
    const before = person.leavePolicyId ?? null;
    if (before === (policy?.id ?? null)) {
      skip(`They are already on ${inWords}.`);
      continue;
    }
    await db().employees.updateOne({ _id: id }, { $set: { leavePolicyId: policy?.id ?? null, updatedAt: clock.nowIso() } });
    if (policy) await openAccount(id);
    result.assigned.push({ employeeId: id, name: person.name });
    audits.push({ action: 'leave_policy.assigned', targetType: 'leave_policy', targetId: policy?.id ?? null, employeeId: id, summary: `Put ${person.name} on ${inWords}.`, before: { leavePolicyId: before }, after: { leavePolicyId: policy?.id ?? null }, selfAdministered: id === ctx.employee.id && ownRecord === 'self_administered' });
  }
  await recordAudits(ctx, audits);
  return result;
}
