import {
  balanceOf,
  can,
  checkLeaveRequest,
  daysInWords,
  decidableBy,
  isLocalDate,
  leaveApprovalVerdict,
  leaveCancelVerdict,
  leaveDatesInWords,
  leaveYearLabel,
  leaveYearOf,
  localDateOf,
  ownRecordVerdict,
  type AccountFacts,
  type LeaveBooking,
  type LeaveCheck,
  type LeaveInboxItem,
  type LeaveListPayload,
  type LeavePreviewPayload,
  type LeaveRequest,
  type LeaveRequestInput,
  type LeaveRow,
  type LeaveType,
  type LeaveView,
  type LocalDate,
  type OrgNode,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, fromDoc, toDoc, type Account, type Doc } from '../db';
import type { RequestContext } from '../http/context';
import { conflict, forbidden, notFound, unprocessable } from '../http/errors';
import { newId } from '../ids';
import { assertInScope, loadOrg } from './access';
import { contextFor, type PersonContext } from './attendance';
import { recordAudit } from './audit';
import { holderOf, markBooking, removeBooking, viewOf, writeAccount, type Holder } from './leaveAccounts';
import { loadLeaveTypes } from './leaveStore';
import { todayFor } from './schedules';

/*
 * Leave requests (plan.md, sections 5.3 and 7.3).
 *
 * A request and the account that holds its days are two documents, and there are no
 * transactions. So:
 *
 * - SENDING. The request is stored first as \`submitting\`, which nobody is shown. Then ONE
 *   versioned write to the account checks the dates against every other booking, checks the
 *   balance, and holds the days (leaveAccounts.ts). Only then does the request become
 *   \`pending\`. Two requests sent at the same instant cannot both pass that one write.
 * - DECIDING. The request's status is the truth. A decision is one conditional write to the
 *   request that only one caller can win; the account is then made to match it by \`settle\`:
 *   approved, the booking is \`taken\`; rejected or cancelled, the booking is removed and the
 *   days are simply available again. Settling looks only at the status as it is now, so it
 *   gives the right answer whatever arrived in between, and doing it twice changes nothing.
 * - A stop between two steps leaves a request \`submitting\`, or marked unsettled. Both are
 *   finished on start-up and whenever requests are read (\`settleLeaveUnfinished\`).
 */

export const LEAVE_PAGE = 20;

const toRequest = (doc: Doc<LeaveRequest>) => fromDoc<LeaveRequest>(doc);

/** A request that is still being sent is shown to nobody. */
const VISIBLE = { $ne: 'submitting' as const };

async function accountOf(ctx: RequestContext | null, employeeId: string): Promise<Account> {
  if (ctx && employeeId === ctx.employee.id) return ctx.employee;
  const doc = await db().employees.findOne({ _id: employeeId });
  if (!doc) throw notFound('That person does not exist.');
  return fromDoc<Account>(doc);
}

/** The shared check, given what was read for the person. \`view\` is their account when it has just been read anew. */
function check(input: LeaveRequestInput, holder: Holder, person: PersonContext, view: AccountFacts | null, options?: { reason: boolean }): LeaveCheck {
  const type = holder.types.find((t) => t.id === input.leaveTypeId) ?? null;
  const entry = holder.policy?.entries.find((e) => e.leaveTypeId === input.leaveTypeId) ?? null;
  const year = isLocalDate(input.startDate) ? leaveYearOf(input.startDate, holder.startMonth) : holder.currentYear;
  // Only this year's account and the next can be asked from. For any other year the check refuses by itself.
  const inReach = year === holder.currentYear || year === holder.currentYear + 1;
  const account = view ?? (inReach ? viewOf(holder, year, clock.nowIso()) : { entries: [], bookings: [], carried: true });
  return checkLeaveRequest(input, { today: holder.today, startMonth: holder.startMonth, type, hasPolicy: holder.policy !== null, entry, account, ctx: person.ctx, serviceStart: holder.serviceStart }, options);
}

async function readFor(employee: Account, now: Date) {
  const person = await contextFor(employee, now);
  const holder = await holderOf(employee, localDateOf(now, person.timeZone));
  return { person, holder };
}

/** What a request would use and leave, before anything is sent. Nothing is written. */
export async function previewLeave(ctx: RequestContext, input: Omit<LeaveRequestInput, 'reason'>): Promise<LeavePreviewPayload> {
  const { person, holder } = await readFor(ctx.employee, clock.now());
  const result = check({ ...input, reason: '' }, holder, person, null, { reason: false });
  return {
    errors: result.errors,
    yearLabel: result.leaveYear === null ? null : leaveYearLabel(result.leaveYear, holder.startMonth),
    days: result.count?.days ?? 0,
    charged: result.count?.charged ?? [],
    notCounted: result.count?.notCounted ?? [],
    balance: result.balance,
  };
}

const refusal = (errors: Record<string, string>) => unprocessable(Object.values(errors)[0] ?? 'That request is not valid.', errors);

/** Sends a leave request for the signed-in person. Nobody asks on someone else's behalf. */
export async function submitLeave(ctx: RequestContext, raw: LeaveRequestInput): Promise<LeaveRequest> {
  const input: LeaveRequestInput = { ...raw, reason: raw.reason.trim() };
  const now = clock.now();
  const { person, holder } = await readFor(ctx.employee, now);
  // Checked once before anything is written, so a request that cannot pass leaves no trace.
  const first = check(input, holder, person, null);
  if (Object.keys(first.errors).length > 0 || !first.count || first.leaveYear === null || !holder.policy) throw refusal(first.errors);

  const request: LeaveRequest = {
    id: newId('lvr'),
    employeeId: ctx.employee.id,
    leaveTypeId: input.leaveTypeId,
    leaveYear: first.leaveYear,
    startDate: input.startDate,
    endDate: input.endDate,
    dayPart: input.dayPart,
    days: first.count.days,
    charged: first.count.charged,
    reason: input.reason,
    approver: holder.policy.approver,
    status: 'submitting',
    settled: false,
    submittedAt: now.toISOString(),
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: '',
  };
  await db().leaveRequests.insertOne(toDoc(request));

  const booking: LeaveBooking = { requestId: request.id, leaveTypeId: request.leaveTypeId, startDate: request.startDate, endDate: request.endDate, dayPart: request.dayPart, days: request.days, state: 'held' };
  try {
    // The one write that decides: overlap, balance and holding the days, against the account as it is at that instant.
    await writeAccount(ctx.employee.id, request.leaveYear, (view, fresh) => {
      const again = check(input, fresh, person, view);
      if (Object.keys(again.errors).length > 0) throw refusal(again.errors);
      return { booking, result: null };
    });
  } catch (error) {
    await db().leaveRequests.deleteOne({ _id: request.id, status: 'submitting' });
    throw error;
  }

  const sent = await db().leaveRequests.updateOne({ _id: request.id, status: 'submitting' }, { $set: { status: 'pending', settled: true } });
  if (sent.matchedCount === 0 && !(await db().leaveRequests.findOne({ _id: request.id }, { projection: { _id: 1 } }))) {
    // The request was cleared away as abandoned while its days were being held: give the days back.
    await removeBooking(ctx.employee.id, request.leaveYear, request.id);
    throw conflict('That took too long and the request was not sent. Nothing was held: send it again.');
  }

  const type = holder.types.find((t) => t.id === request.leaveTypeId);
  await recordAudit(ctx, { action: 'leave.requested', targetType: 'leave_request', targetId: request.id, employeeId: request.employeeId, summary: `${ctx.employee.name} asked for ${daysInWords(request.days)} of ${type?.name ?? 'leave'}: ${leaveDatesInWords(request)}.`, after: { leaveTypeId: request.leaveTypeId, startDate: request.startDate, endDate: request.endDate, dayPart: request.dayPart, days: request.days, charged: request.charged } });
  return { ...request, status: 'pending', settled: true };
}

/**
 * Makes the account match a request's status as it is now. Safe to run any number of times,
 * by any number of callers at once.
 */
export async function settleLeave(id: string) {
  for (let round = 0; round < 5; round += 1) {
    const doc = await db().leaveRequests.findOne({ _id: id });
    if (!doc || doc.settled || doc.status === 'submitting') return;
    if (doc.status === 'approved') await markBooking(doc.employeeId, doc.leaveYear, id, 'taken');
    else if (doc.status === 'pending') await markBooking(doc.employeeId, doc.leaveYear, id, 'held');
    else await removeBooking(doc.employeeId, doc.leaveYear, id);
    // Settled only if the status is still the one that was applied. If it moved on meanwhile, go round again.
    const done = await db().leaveRequests.updateOne({ _id: id, status: doc.status, settled: false }, { $set: { settled: true } });
    if (done.matchedCount === 1) return;
  }
}

/**
 * Finishes what a stop left half done:
 * - a request still \`submitting\` becomes \`pending\` if its days are held in the account, and
 *   is removed if they are not (it never reached the one write that decides);
 * - a request decided but not settled has its account made to match.
 *
 * @param graceMs leave alone a \`submitting\` request younger than this: it may simply be on its way
 */
export async function settleLeaveUnfinished(graceMs = 0): Promise<number> {
  const before = new Date(clock.now().getTime() - graceMs).toISOString();
  const submitting = await db().leaveRequests.find({ status: 'submitting', submittedAt: { $lte: before } }).toArray();
  for (const doc of submitting) {
    const held = await db().leaveAccounts.countDocuments({ employeeId: doc.employeeId, leaveYear: doc.leaveYear, 'bookings.requestId': doc._id });
    if (held > 0) await db().leaveRequests.updateOne({ _id: doc._id, status: 'submitting' }, { $set: { status: 'pending', settled: true } });
    else await db().leaveRequests.deleteOne({ _id: doc._id, status: 'submitting' });
  }
  const unsettled = await db().leaveRequests.find({ status: VISIBLE, settled: false }, { projection: { _id: 1 } }).toArray();
  for (const doc of unsettled) await settleLeave(doc._id);
  return submitting.length + unsettled.length;
}

/** A request still on its way may be a few moments old; one older than this was abandoned. */
const SUBMITTING_GRACE_MS = 60_000;

/** The request, if the caller may decide it. Their own is refused; one that is not theirs to decide does not exist for them. */
async function decidable(ctx: RequestContext, id: string, org: readonly OrgNode[]): Promise<LeaveRequest> {
  const doc = await db().leaveRequests.findOne({ _id: id, status: VISIBLE });
  const verdict = doc ? leaveApprovalVerdict(ctx.employee, doc, org) : 'not_theirs';
  if (!doc || verdict === 'not_theirs') throw notFound('That request does not exist.');
  if (verdict === 'own') throw forbidden('You cannot decide your own request. Someone else has to.');
  return toRequest(doc);
}

const alreadyDecided = (request: Pick<LeaveRequest, 'status' | 'decidedByName'>) => conflict(`That request was already ${request.status}${request.decidedByName && request.status !== 'cancelled' ? ` by ${request.decidedByName}` : ''}.`);

async function decide(ctx: RequestContext, id: string, status: 'approved' | 'rejected', rawNote: string): Promise<LeaveRequest> {
  const request = await decidable(ctx, id, await loadOrg());
  if (request.status !== 'pending') throw alreadyDecided(request);
  const note = rawNote.trim();
  // One winner: only a request that is still waiting is decided.
  const decided = await db().leaveRequests.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status, settled: false, decidedBy: ctx.employee.id, decidedByName: ctx.employee.name, decidedAt: clock.nowIso(), decisionNote: note } }, { returnDocument: 'after' });
  if (!decided) throw alreadyDecided((await db().leaveRequests.findOne({ _id: id })) ?? request);
  await settleLeave(id);

  const [target, types] = await Promise.all([db().employees.findOne({ _id: request.employeeId }, { projection: { name: 1 } }), loadLeaveTypes()]);
  const what = `${target?.name ?? 'someone'}'s ${daysInWords(request.days)} of ${types.find((t) => t.id === request.leaveTypeId)?.name ?? 'leave'} (${leaveDatesInWords(request)})`;
  await recordAudit(ctx, { action: `leave.${status}`, targetType: 'leave_request', targetId: id, employeeId: request.employeeId, summary: status === 'approved' ? `Approved ${what}.` : `Rejected ${what}: ${note}`, after: { status, note: note || undefined, days: request.days } });
  return { ...toRequest(decided), settled: true };
}

/** Approves a request. The days were held when it was sent, so approving cannot overdraw. */
export const approveLeave = (ctx: RequestContext, id: string, note: string) => decide(ctx, id, 'approved', note);

/** Rejects a request, with the reason. Its days are available again. */
export const rejectLeave = (ctx: RequestContext, id: string, note: string) => decide(ctx, id, 'rejected', note);

/**
 * Cancels a request: the person themself while it waits or until its first day, HR after
 * that, with a reason. Whatever it held or took is available again.
 */
export async function cancelLeave(ctx: RequestContext, id: string, rawReason: string): Promise<LeaveRequest> {
  const doc = await db().leaveRequests.findOne({ _id: id, status: VISIBLE });
  const own = doc?.employeeId === ctx.employee.id;
  // Someone else's request is answered exactly as one that does not exist, unless the caller is HR.
  if (!doc || (!own && !ctx.can('requests.approveAll'))) throw notFound('That request does not exist.');
  const request = toRequest(doc);
  const ownRecord = own ? ownRecordVerdict(ctx.employee, [ctx.employee.id], await loadOrg()) : 'ok';
  const verdict = leaveCancelVerdict(request, ctx.employee, await todayFor(request.employeeId), ownRecord);
  if (!verdict.allowed) throw verdict.hidden ? notFound('That request does not exist.') : conflict(verdict.reason);
  const reason = rawReason.trim();
  if (verdict.byHr && reason.length === 0) throw unprocessable('Say why this leave is cancelled.', { reason: 'Say why this leave is cancelled.' });

  const cancelled = await db().leaveRequests.findOneAndUpdate({ _id: id, status: request.status }, { $set: { status: 'cancelled', settled: false, decidedBy: ctx.employee.id, decidedByName: ctx.employee.name, decidedAt: clock.nowIso(), decisionNote: reason } }, { returnDocument: 'after' });
  if (!cancelled) throw alreadyDecided((await db().leaveRequests.findOne({ _id: id })) ?? request);
  await settleLeave(id);

  const [target, types] = await Promise.all([accountOf(ctx, request.employeeId), loadLeaveTypes()]);
  const typeName = types.find((t) => t.id === request.leaveTypeId)?.name ?? 'leave';
  await recordAudit(ctx, {
    action: 'leave.cancelled',
    targetType: 'leave_request',
    targetId: id,
    employeeId: request.employeeId,
    summary: own && !verdict.byHr ? `${ctx.employee.name} cancelled their ${request.status === 'approved' ? 'approved ' : ''}${typeName} (${leaveDatesInWords(request)}).` : `Cancelled ${target.name}'s approved ${typeName} (${leaveDatesInWords(request)}): ${reason}`,
    before: { status: request.status },
    after: { status: 'cancelled', days: request.days, reason: reason || undefined },
    selfAdministered: ownRecord === 'self_administered' && verdict.byHr,
  });
  return { ...toRequest(cancelled), settled: true };
}

interface RowFacts {
  types: Map<string, LeaveType>;
  people: Map<string, { name: string; code: string }>;
  /** What the caller may do about a request: worked out by the shared \`leaveCancelVerdict\`. */
  cancel: (request: LeaveRequest) => LeaveRow['cancel'];
}

function toRow(request: LeaveRequest, facts: RowFacts): LeaveRow {
  const type = facts.types.get(request.leaveTypeId);
  const person = facts.people.get(request.employeeId);
  return { ...request, employeeName: person?.name ?? 'Someone', employeeCode: person?.code ?? '', typeName: type?.name ?? 'Leave', typeCode: type?.code ?? '', typeTone: type?.tone ?? 'slate', paid: type?.paid ?? true, cancel: facts.cancel(request) };
}

/** What every list of requests needs beside the requests: the kinds of leave, the people's names, and what the caller may cancel. */
async function rowFactsFor(viewer: Pick<Account, 'id' | 'role'>, requests: readonly LeaveRequest[], org?: readonly OrgNode[]): Promise<RowFacts> {
  const ids = [...new Set(requests.map((r) => r.employeeId))];
  const hasOwn = ids.includes(viewer.id);
  const [types, people, myToday, everyone] = await Promise.all([
    loadLeaveTypes(),
    db().employees.find({ _id: { $in: ids } }, { projection: { name: 1, code: 1 } }).toArray(),
    hasOwn ? todayFor(viewer.id) : Promise.resolve<LocalDate>(''),
    hasOwn ? (org ?? loadOrg()) : Promise.resolve<readonly OrgNode[]>([]),
  ]);
  const ownRecord = hasOwn ? ownRecordVerdict(viewer, [viewer.id], everyone) : 'ok';
  return {
    types: new Map(types.map((t) => [t.id, t])),
    people: new Map(people.map((p) => [p._id, { name: p.name, code: p.code }])),
    cancel: (request) => {
      const own = request.employeeId === viewer.id;
      // For someone else's request the answer does not depend on the date: only on whether the caller is HR.
      const verdict = leaveCancelVerdict(request, viewer, own ? myToday : request.startDate, own ? ownRecord : 'ok');
      return !verdict.allowed ? 'no' : verdict.byHr ? 'with_reason' : 'yes';
    },
  };
}

/** Rows for some requests, as the caller may see them. */
export async function leaveRows(viewer: Pick<Account, 'id' | 'role'>, requests: readonly LeaveRequest[]): Promise<LeaveRow[]> {
  if (requests.length === 0) return [];
  const facts = await rowFactsFor(viewer, requests);
  return requests.map((request) => toRow(request, facts));
}

/** Which waiting leave requests are a person's to decide: by whom they are from, and by what their policy said. */
async function inboxFilter(employee: Pick<Account, 'id' | 'role'>, org: readonly OrgNode[]) {
  return { employeeId: { $in: decidableBy(employee, org) }, ...(can(employee.role, 'requests.approveAll') ? {} : { approver: 'manager' as const }) };
}

/** How many leave requests are waiting for this person to decide. 0 for someone who decides none. */
export async function leaveWaitingFor(employee: Pick<Account, 'id' | 'role'>, org: readonly OrgNode[]): Promise<number> {
  const filter = await inboxFilter(employee, org);
  return filter.employeeId.$in.length === 0 ? 0 : db().leaveRequests.countDocuments({ ...filter, status: 'pending' });
}

/**
 * Requests, four ways:
 * - \`mine\`: the caller's own, newest first, whatever their state;
 * - \`person\`: one person's, for someone who may see them;
 * - \`inbox\`: the ones waiting for the caller to decide, oldest first, each with what it does to the balance;
 * - \`decided\`: the ones already decided among the people the caller decides for.
 */
export async function listLeave(ctx: RequestContext, view: LeaveView, page: number, employeeId?: string): Promise<LeaveListPayload> {
  await settleLeaveUnfinished(SUBMITTING_GRACE_MS);
  const skip = (page - 1) * LEAVE_PAGE;
  const answer = (items: LeaveListPayload['items'], total: number): LeaveListPayload => ({ view, items, total, page, pageSize: LEAVE_PAGE });

  if (view === 'mine' || view === 'person') {
    const whose = view === 'mine' ? ctx.employee.id : employeeId;
    if (!whose) throw unprocessable('Say whose leave to list.', { employeeId: 'Choose a person.' });
    if (view === 'person') await assertInScope(ctx, whose);
    const filter = { employeeId: whose, status: VISIBLE };
    const [total, docs] = await Promise.all([db().leaveRequests.countDocuments(filter), db().leaveRequests.find(filter).sort({ submittedAt: -1, _id: -1 }).skip(skip).limit(LEAVE_PAGE).toArray()]);
    return answer(await leaveRows(ctx.employee, docs.map(toRequest)), total);
  }

  if (!ctx.can('team.approve') && !ctx.can('requests.approveAll')) throw forbidden();
  const org = await loadOrg();
  const filter = { ...(await inboxFilter(ctx.employee, org)), status: view === 'inbox' ? ('pending' as const) : { $in: ['approved', 'rejected', 'cancelled'] as const } };
  const [total, docs] = await Promise.all([
    db().leaveRequests.countDocuments(filter),
    db()
      .leaveRequests.find(filter)
      .sort(view === 'inbox' ? { submittedAt: 1, _id: 1 } : { decidedAt: -1, _id: -1 })
      .skip(skip)
      .limit(LEAVE_PAGE)
      .toArray(),
  ]);
  const requests = docs.map(toRequest);
  const facts = await rowFactsFor(ctx.employee, requests, org);
  if (view === 'decided') return answer(requests.map((request) => toRow(request, facts)), total);

  // The inbox shows what each request does to the balance: read each person's account once.
  const accounts = new Map<string, Holder>();
  const at = clock.nowIso();
  const items: LeaveInboxItem[] = [];
  for (const request of requests) {
    let holder = accounts.get(request.employeeId);
    if (!holder) {
      holder = await holderOf(await accountOf(null, request.employeeId));
      accounts.set(request.employeeId, holder);
    }
    const type = facts.types.get(request.leaveTypeId);
    const entry = holder.policy?.entries.find((e) => e.leaveTypeId === request.leaveTypeId);
    items.push({ ...toRow(request, facts), balance: balanceOf(viewOf(holder, request.leaveYear, at), request.leaveTypeId), unlimited: !(type?.paid ?? true) || Boolean(entry?.allowNegative) });
  }
  return answer(items, total);
}

/** The signed-in person's own leave for their home page: requests still waiting, and approved leave that is not over yet. */
export async function myLeaveAhead(employee: Account, today: LocalDate, limit: number): Promise<{ waiting: LeaveRow[]; upcoming: LeaveRow[] }> {
  const [waiting, upcoming] = await Promise.all([
    db().leaveRequests.find({ employeeId: employee.id, status: 'pending' }).sort({ startDate: 1 }).toArray(),
    db().leaveRequests.find({ employeeId: employee.id, status: 'approved', endDate: { $gte: today } }).sort({ startDate: 1 }).limit(limit).toArray(),
  ]);
  const rows = await leaveRows(employee, [...waiting, ...upcoming].map(toRequest));
  return { waiting: rows.slice(0, waiting.length), upcoming: rows.slice(waiting.length) };
}
