import {
  approvalVerdict,
  assignmentOn,
  can,
  changeKind,
  correctableOf,
  correctionTypesFor,
  DAY_CHANGED,
  DAY_NOTE_MAX,
  decidableBy,
  evaluateDay,
  leaveOnDate,
  localDateOf,
  monthOf,
  monthRange,
  ownRecordVerdict,
  previewCorrection,
  requestBlocker,
  staleProblem,
  validateCorrection,
  validateDirectCorrection,
  type CorrectionChange,
  type CorrectionInboxItem,
  type CorrectionInput,
  type CorrectionListPayload,
  type CorrectionRequest,
  type CorrectionRow,
  type CorrectionView,
  type DayDetailPayload,
  type DayState,
  type DirectCorrectionInput,
  type LocalDate,
  type OrgNode,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { attendanceId, db, fromDoc, isDuplicateKey, toDoc, type Account, type AttendanceDayDoc } from '../db';
import type { RequestContext } from '../http/context';
import { conflict, forbidden, HttpError, notFound, unprocessable } from '../http/errors';
import { newId } from '../ids';
import { assertInScope, guardOwnRecord, loadOrg } from './access';
import { contextFor, inputFor, rulesOf, toRecord, type PersonContext } from './attendance';
import { recordAudit } from './audit';

/*
 * Attendance corrections (plan.md, sections 5.3 and 8).
 *
 * A request and the day it corrects are two documents, and there are no transactions. So:
 *
 * - The request's status is the truth. A decision is one conditional write to the request
 *   that only one caller can win (pending to approved, rejected or cancelled).
 * - An approval is then applied to the day by `applyToDay`: ONE write that sets the corrected
 *   facts and adds the history row holding what was there before. The row carries the
 *   request's id and the write skips a day that already has it, so applying twice, or by two
 *   approvers at once, or again after a crash, changes nothing the second time.
 * - A request marked approved but not yet settled is finished on start-up and whenever
 *   requests are read (`settleUnfinished`).
 *
 * The punches themselves are never edited away: the day's history keeps every earlier value.
 */

export const CORRECTIONS_PAGE = 20;

const toRequest = (doc: Parameters<typeof fromDoc<CorrectionRequest>>[0]) => fromDoc<CorrectionRequest>(doc);

async function accountOf(ctx: RequestContext | null, employeeId: string): Promise<Account> {
  if (ctx && employeeId === ctx.employee.id) return ctx.employee;
  const doc = await db().employees.findOne({ _id: employeeId });
  if (!doc) throw notFound('That person does not exist.');
  return fromDoc<Account>(doc);
}

interface ReadDay {
  person: PersonContext;
  doc: AttendanceDayDoc | null;
  state: DayState;
  /** 0 when nothing is recorded for the day. */
  version: number;
}

/** One person's one day, as the correction rules see it, read now. */
async function readDay(target: Account, date: LocalDate, now: Date): Promise<ReadDay> {
  const person = await contextFor(target, now);
  const doc = await db().attendanceDays.findOne({ _id: attendanceId(target.id, date) });
  const input = inputFor(doc, person, date);
  const rules = (doc && rulesOf(doc, person)) || person.ctx.rulesOn(date);
  return { person, doc, version: doc?.version ?? 0, state: { date, day: evaluateDay(date, now, person.ctx, input), facts: input.record, rules } };
}

/** Requests already made for days of the same month that are waiting or were approved. */
function usedInMonth(employeeId: string, date: LocalDate): Promise<number> {
  const { from, to } = monthRange(monthOf(date));
  return db().corrections.countDocuments({ employeeId, status: { $in: ['pending', 'approved'] }, date: { $gte: from, $lte: to } });
}

const NO_SCHEDULE = 'You have no work schedule yet, so there is no attendance to correct.';
const ALREADY_WAITING = 'A correction for this day is already waiting for a decision. Cancel it first to ask for something else.';

/** Sends a request to correct one of the signed-in person's own days. Nobody asks on someone else's behalf. */
export async function submitCorrection(ctx: RequestContext, input: CorrectionInput): Promise<CorrectionRequest> {
  const now = clock.now();
  const { person, state, version } = await readDay(ctx.employee, input.date, now);
  if (!person.rules) throw conflict(NO_SCHEDULE);
  const blocked = requestBlocker(input.date, localDateOf(now, person.timeZone), person.rules.corrections, await usedInMonth(ctx.employee.id, input.date), person.pendingDates.has(input.date));
  if (blocked) throw conflict(blocked);
  const { errors, change } = validateCorrection(input, state, person.ctx, now);
  if (!change) throw unprocessable(Object.values(errors)[0] ?? 'That request is not valid.', errors);

  const request: CorrectionRequest = {
    id: newId('cor'),
    employeeId: ctx.employee.id,
    date: input.date,
    type: input.type,
    original: { ...correctableOf(state.facts), status: state.day.status, version },
    requested: change,
    reason: input.reason.trim(),
    status: 'pending',
    settled: true,
    submittedAt: now.toISOString(),
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: '',
  };
  try {
    await db().corrections.insertOne(toDoc(request));
  } catch (error) {
    // The database allows one open request per person per day, also when two arrive together.
    if (isDuplicateKey(error)) throw conflict(ALREADY_WAITING);
    throw error;
  }
  await recordAudit(ctx, { action: 'correction.requested', targetType: 'correction', targetId: request.id, employeeId: request.employeeId, summary: `${ctx.employee.name} asked for a correction of ${input.date} (${input.type.replaceAll('_', ' ')}).`, before: request.original, after: change });
  return request;
}

/** Takes back one's own request while it is still waiting. */
export async function cancelCorrection(ctx: RequestContext, id: string): Promise<CorrectionRequest> {
  const existing = await db().corrections.findOne({ _id: id });
  // Someone else's request is answered exactly as one that does not exist.
  if (!existing || existing.employeeId !== ctx.employee.id) throw notFound('That request does not exist.');
  const at = clock.nowIso();
  const cancelled = await db().corrections.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'cancelled', settled: true, decidedBy: ctx.employee.id, decidedByName: ctx.employee.name, decidedAt: at } }, { returnDocument: 'after' });
  if (!cancelled) throw conflict(`That request has already been ${existing.status === 'pending' ? 'decided' : existing.status}.`);
  await recordAudit(ctx, { action: 'correction.cancelled', targetType: 'correction', targetId: id, employeeId: existing.employeeId, summary: `${ctx.employee.name} cancelled their request to correct ${existing.date}.` });
  return toRequest(cancelled);
}

interface Application {
  employeeId: string;
  date: LocalDate;
  /** The assignment in force on the date, for a day that has no document yet. */
  assignmentId: string | null;
  change: CorrectionChange;
  /** Set to replace HR's note on the day; null removes it. Left out, the note is untouched. */
  note?: { text: string; by: string; byName: string; at: string } | null;
  kind: 'corrected' | 'overridden' | 'excused' | 'note';
  by: { id: string; name: string };
  at: string;
  reason: string;
  /** The request being settled. A day whose history already holds it is left alone. */
  requestId?: string;
  /** Only when the day is still at this version (0: still has no document). For a direct edit by HR. */
  expectVersion?: number;
}

/** A value written into a pipeline update as it is. Without this, text starting with "$" would be read as a field name. */
const literal = (value: unknown) => ({ $literal: value });
/** A field of the day as it is before the write, or a fallback when the day has no document yet. */
const before = (field: string, fallback: unknown = null) => ({ $ifNull: [`$${field}`, fallback] });

/**
 * The one write that changes a day after the fact. It sets the corrected facts and, in the
 * same write, adds a history row with the values that were there a moment before (read by
 * the database itself, so nothing can slip in between), who did it, when, and why.
 *
 * - `applied`: done.
 * - `already`: the day's history already holds this request. Nothing was changed.
 * - `changed`: the day is no longer at the version the caller expected. Nothing was changed.
 */
async function applyToDay(a: Application): Promise<'applied' | 'already' | 'changed'> {
  const _id = attendanceId(a.employeeId, a.date);
  const { change } = a;
  const after: Record<string, unknown> = { ...change, ...(a.note !== undefined ? { note: a.note?.text ?? null } : {}) };
  const was = a.kind === 'note' ? { note: before('note.text') } : { checkInAt: before('checkInAt'), checkOutAt: before('checkOutAt'), override: before('override'), lateExcused: before('lateExcused', false) };
  const entry = {
    at: literal(a.at),
    by: literal(a.by.id),
    byName: literal(a.by.name),
    kind: literal(a.kind),
    before: was,
    after: literal(after),
    ...(a.reason ? { reason: literal(a.reason) } : {}),
    ...(a.requestId ? { requestId: literal(a.requestId) } : {}),
  };

  const filter: Record<string, unknown> = { _id };
  if (a.requestId) filter['history.requestId'] = { $ne: a.requestId };
  if (a.expectVersion !== undefined) filter.version = a.expectVersion > 0 ? a.expectVersion : { $exists: false };

  try {
    await db().attendanceDays.updateOne(
      filter,
      [
        {
          $set: {
            employeeId: before('employeeId', a.employeeId),
            date: before('date', a.date),
            assignmentId: before('assignmentId', a.assignmentId),
            checkInAt: 'checkInAt' in change ? literal(change.checkInAt ?? null) : before('checkInAt'),
            checkOutAt: 'checkOutAt' in change ? literal(change.checkOutAt ?? null) : before('checkOutAt'),
            breaks: before('breaks', []),
            override: 'override' in change ? literal(change.override ?? null) : before('override'),
            lateExcused: 'lateExcused' in change ? literal(Boolean(change.lateExcused)) : before('lateExcused', false),
            note: a.note !== undefined ? literal(a.note) : before('note'),
            history: { $concatArrays: [before('history', []), [entry]] },
            version: { $add: [before('version', 0), 1] },
            createdAt: before('createdAt', a.at),
            updatedAt: literal(a.at),
          },
        },
      ],
      { upsert: true },
    );
    return 'applied';
  } catch (error) {
    // The filter matched nothing and the day exists: it already holds this request, or it has moved on.
    if (!isDuplicateKey(error)) throw error;
    const held = a.requestId ? await db().attendanceDays.countDocuments({ _id, 'history.requestId': a.requestId }) : 0;
    return held > 0 ? 'already' : 'changed';
  }
}

/** The assignment a correction on a date belongs to, for a day that has no document yet. */
const assignmentIdOn = (person: PersonContext, date: LocalDate) => assignmentOn(person.assignments, date)?.id ?? null;

/**
 * Makes the day match an approved request. Safe to run any number of times: the day is only
 * ever changed once per request.
 */
export async function settleCorrection(request: CorrectionRequest) {
  if (request.status !== 'approved' || request.settled) return;
  const target = await db().employees.findOne({ _id: request.employeeId });
  if (target) {
    const person = await contextFor(fromDoc<Account>(target), clock.now());
    await applyToDay({
      employeeId: request.employeeId,
      date: request.date,
      assignmentId: assignmentIdOn(person, request.date),
      change: request.requested,
      kind: changeKind(request.requested),
      by: { id: request.decidedBy ?? '', name: request.decidedByName ?? '' },
      at: request.decidedAt ?? clock.nowIso(),
      reason: request.reason,
      requestId: request.id,
    });
  }
  await db().corrections.updateOne({ _id: request.id, status: 'approved' }, { $set: { settled: true } });
}

/** Finishes any approval that was decided but not yet applied to its day: after a crash, say. */
export async function settleUnfinished(): Promise<number> {
  const unfinished = await db().corrections.find({ status: 'approved', settled: false }).toArray();
  for (const doc of unfinished) await settleCorrection(toRequest(doc));
  return unfinished.length;
}

/** The request, if the caller may decide it. Their own is refused; one that is not theirs to decide does not exist for them. */
async function decidable(ctx: RequestContext, id: string, org: readonly OrgNode[]): Promise<CorrectionRequest> {
  const doc = await db().corrections.findOne({ _id: id });
  const verdict = doc ? approvalVerdict(ctx.employee, doc.employeeId, org) : 'not_theirs';
  if (!doc || verdict === 'not_theirs') throw notFound('That request does not exist.');
  if (verdict === 'own') throw forbidden('You cannot decide your own request. Someone else has to.');
  return toRequest(doc);
}

const alreadyDecided = (request: Pick<CorrectionRequest, 'status' | 'decidedByName'>) => conflict(`That request was already ${request.status}${request.decidedByName && request.status !== 'cancelled' ? ` by ${request.decidedByName}` : ''}.`);

/**
 * Approves a request. The approver names the version of the day they were looking at: if
 * the day has changed since, nothing is decided and they are shown the day as it is now.
 */
export async function approveCorrection(ctx: RequestContext, id: string, dayVersion: number, note: string): Promise<CorrectionRequest> {
  const org = await loadOrg();
  const request = await decidable(ctx, id, org);
  if (request.status !== 'pending') throw alreadyDecided(request);

  const now = clock.now();
  const target = await accountOf(null, request.employeeId);
  const read = await readDay(target, request.date, now);
  if (read.version !== dayVersion) {
    throw new HttpError(409, 'The day has changed since you opened this request. Look at it again before deciding.', undefined, DAY_CHANGED, await inboxItem(request, target, now, read));
  }
  const problem = staleProblem(request, read.state, read.person.ctx, now);
  if (problem) throw conflict(`This request no longer fits the day, so it can only be rejected. ${problem}`);

  // One winner: only a request that is still waiting becomes approved.
  const decidedAt = now.toISOString();
  const decided = await db().corrections.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'approved', settled: false, decidedBy: ctx.employee.id, decidedByName: ctx.employee.name, decidedAt, decisionNote: note.trim() } },
    { returnDocument: 'after' },
  );
  if (!decided) throw alreadyDecided((await db().corrections.findOne({ _id: id })) ?? request);

  const approved = toRequest(decided);
  await settleCorrection(approved);
  await recordAudit(ctx, {
    action: 'correction.approved',
    targetType: 'correction',
    targetId: id,
    employeeId: request.employeeId,
    summary: `Approved ${target.name}'s request to correct ${request.date} (${request.type.replaceAll('_', ' ')}).`,
    before: correctableOf(read.state.facts),
    after: { ...request.requested, note: note.trim() || undefined },
  });
  return { ...approved, settled: true };
}

/** Rejects a request, with the reason. The day is not touched. */
export async function rejectCorrection(ctx: RequestContext, id: string, note: string): Promise<CorrectionRequest> {
  const org = await loadOrg();
  const request = await decidable(ctx, id, org);
  if (request.status !== 'pending') throw alreadyDecided(request);
  const rejected = await db().corrections.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'rejected', settled: true, decidedBy: ctx.employee.id, decidedByName: ctx.employee.name, decidedAt: clock.nowIso(), decisionNote: note.trim() } },
    { returnDocument: 'after' },
  );
  if (!rejected) throw alreadyDecided((await db().corrections.findOne({ _id: id })) ?? request);
  const target = await db().employees.findOne({ _id: request.employeeId }, { projection: { name: 1 } });
  await recordAudit(ctx, { action: 'correction.rejected', targetType: 'correction', targetId: id, employeeId: request.employeeId, summary: `Rejected ${target?.name ?? 'someone'}'s request to correct ${request.date}: ${note.trim()}`, after: { note: note.trim() } });
  return toRequest(rejected);
}

/** A waiting request with what its approver needs: the day as it is, and as it would be. */
async function inboxItem(request: CorrectionRequest, target: Account, now: Date, read?: ReadDay): Promise<CorrectionInboxItem> {
  const { person, state, version } = read ?? (await readDay(target, request.date, now));
  const problem = staleProblem(request, state, person.ctx, now);
  return {
    ...request,
    employeeName: target.name,
    employeeCode: target.code,
    timeZone: state.rules?.timeZone ?? person.timeZone,
    // "Correction pending" on the day is this very request: saying so to its approver adds nothing.
    now: { ...state.day, flags: state.day.flags.filter((flag) => flag !== 'pending_correction') },
    after: problem ? null : previewCorrection(state, request.requested, person.ctx, now, { leave: leaveOnDate(person.leave, request.date) }),
    problem,
    dayVersion: version,
  };
}

/** How many requests are waiting for this person to decide. 0 for someone who decides none. */
export async function approvalsWaitingFor(employee: Pick<Account, 'id' | 'role'>): Promise<number> {
  if (!can(employee.role, 'team.approve') && !can(employee.role, 'requests.approveAll')) return 0;
  const ids = decidableBy(employee, await loadOrg());
  return ids.length === 0 ? 0 : db().corrections.countDocuments({ status: 'pending', employeeId: { $in: ids } });
}

/** One's own requests that are still waiting, oldest first. */
export async function pendingOf(employeeId: string): Promise<CorrectionRequest[]> {
  return (await db().corrections.find({ employeeId, status: 'pending' }).sort({ submittedAt: 1 }).toArray()).map(toRequest);
}

/**
 * Requests, three ways:
 * - `mine`: the caller's own, newest first, whatever their state;
 * - `inbox`: the ones waiting for the caller to decide, oldest first, each with the day as it
 *   is now and as it would read;
 * - `decided`: the ones already decided among the people the caller decides for.
 */
export async function listCorrections(ctx: RequestContext, view: CorrectionView, page: number): Promise<CorrectionListPayload> {
  await settleUnfinished();
  const skip = (page - 1) * CORRECTIONS_PAGE;
  if (view === 'mine') {
    const filter = { employeeId: ctx.employee.id };
    const [total, docs, person] = await Promise.all([db().corrections.countDocuments(filter), db().corrections.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(CORRECTIONS_PAGE).toArray(), contextFor(ctx.employee, clock.now())]);
    const items: CorrectionRow[] = docs.map((doc) => ({ ...toRequest(doc), employeeName: ctx.employee.name, employeeCode: ctx.employee.code, timeZone: person.ctx.rulesOn(doc.date)?.timeZone ?? person.timeZone }));
    return { view, items, total, page, pageSize: CORRECTIONS_PAGE };
  }

  if (!ctx.can('team.approve') && !ctx.can('requests.approveAll')) throw forbidden();
  const ids = decidableBy(ctx.employee, await loadOrg());
  const filter = { employeeId: { $in: ids }, status: view === 'inbox' ? ('pending' as const) : { $ne: 'pending' as const } };
  const [total, docs] = await Promise.all([
    db().corrections.countDocuments(filter),
    db()
      .corrections.find(filter)
      .sort(view === 'inbox' ? { submittedAt: 1 } : { decidedAt: -1 })
      .skip(skip)
      .limit(CORRECTIONS_PAGE)
      .toArray(),
  ]);
  const people = new Map((await db().employees.find({ _id: { $in: [...new Set(docs.map((d) => d.employeeId))] } }).toArray()).map((doc) => [doc._id, fromDoc<Account>(doc)]));
  const now = clock.now();
  const items: (CorrectionRow | CorrectionInboxItem)[] = [];
  for (const doc of docs) {
    const target = people.get(doc.employeeId);
    if (!target) continue;
    if (view === 'inbox') items.push(await inboxItem(toRequest(doc), target, now));
    else {
      const person = await contextFor(target, now);
      items.push({ ...toRequest(doc), employeeName: target.name, employeeCode: target.code, timeZone: person.ctx.rulesOn(doc.date)?.timeZone ?? person.timeZone });
    }
  }
  return { view, items, total, page, pageSize: CORRECTIONS_PAGE };
}

/** One day of one person, read now: how it reads, what was recorded, its history, and what the caller may do about it. */
export async function dayDetail(ctx: RequestContext, employeeId: string, date: LocalDate): Promise<DayDetailPayload> {
  await assertInScope(ctx, employeeId);
  const target = await accountOf(ctx, employeeId);
  const now = clock.now();
  const { person, doc, state, version } = await readDay(target, date, now);
  const pending = await db().corrections.findOne({ employeeId, date, status: 'pending' });
  const today = localDateOf(now, person.timeZone);

  let requestable: DayDetailPayload['requestable'] = null;
  if (employeeId === ctx.employee.id) {
    const types = correctionTypesFor(state);
    const blocked = !person.rules ? NO_SCHEDULE : requestBlocker(date, today, person.rules.corrections, await usedInMonth(employeeId, date), pending !== null);
    requestable = { types: blocked ? [] : types, blocked: blocked ?? (types.length === 0 ? 'There is nothing on this day that a correction could change.' : null) };
  }
  // HR may correct or annotate a day that counts and has begun, and never their own (unless nobody else could).
  const editable = ctx.can('attendance.edit') && state.day.kind !== null && date <= today && ownRecordVerdict(ctx.employee, [employeeId], await loadOrg()) !== 'blocked';

  return { day: state.day, record: doc ? toRecord(doc) : null, scheduleName: state.rules?.name ?? null, timeZone: state.rules?.timeZone ?? null, version, pending: pending ? toRequest(pending) : null, requestable, editable };
}

/** Why a day cannot be edited directly by HR at all. */
function assertEditable(state: DayState, date: LocalDate, today: LocalDate) {
  if (state.day.kind === null) throw conflict('Attendance is not counted for them on this day, so there is nothing to change.');
  if (date > today) throw conflict('A day that has not come yet has nothing to change.');
}

const dayChanged = () => new HttpError(409, 'The day has changed since you opened it. Look at it again before changing it.', undefined, DAY_CHANGED);

/**
 * HR corrects a day directly: the same write and the same history as an approved request,
 * with HR's reason. Never on their own record, and never over a day that has changed since
 * they looked at it.
 */
export async function correctDay(ctx: RequestContext, employeeId: string, date: LocalDate, input: DirectCorrectionInput): Promise<DayDetailPayload> {
  await assertInScope(ctx, employeeId);
  const { selfAdministered } = await guardOwnRecord(ctx, [employeeId]);
  const target = await accountOf(ctx, employeeId);
  const now = clock.now();
  const read = await readDay(target, date, now);
  assertEditable(read.state, date, localDateOf(now, read.person.timeZone));
  if (read.version !== input.dayVersion) throw dayChanged();
  const { errors, change } = validateDirectCorrection(input, read.state, read.person.ctx, now);
  if (!change) throw unprocessable(Object.values(errors)[0] ?? 'That correction is not valid.', errors);

  const outcome = await applyToDay({ employeeId, date, assignmentId: assignmentIdOn(read.person, date), change, kind: changeKind(change), by: ctx.employee, at: now.toISOString(), reason: input.reason.trim(), expectVersion: read.version });
  if (outcome !== 'applied') throw dayChanged();
  await recordAudit(ctx, { action: 'attendance.corrected', targetType: 'attendance_day', targetId: attendanceId(employeeId, date), employeeId, summary: `Corrected ${target.name}'s attendance on ${date}: ${input.reason.trim()}`, before: correctableOf(read.state.facts), after: change, selfAdministered });
  return dayDetail(ctx, employeeId, date);
}

/** HR leaves a note on a day, changes it, or (with empty text) removes it. Shown to the person and their managers. */
export async function noteDay(ctx: RequestContext, employeeId: string, date: LocalDate, rawText: string): Promise<DayDetailPayload> {
  await assertInScope(ctx, employeeId);
  const { selfAdministered } = await guardOwnRecord(ctx, [employeeId]);
  const target = await accountOf(ctx, employeeId);
  const text = rawText.trim();
  if (text.length > DAY_NOTE_MAX) throw unprocessable(`Keep the note to ${DAY_NOTE_MAX} characters or fewer.`, { text: `Keep the note to ${DAY_NOTE_MAX} characters or fewer.` });
  const now = clock.now();
  const read = await readDay(target, date, now);
  assertEditable(read.state, date, localDateOf(now, read.person.timeZone));
  const existing = read.doc?.note?.text ?? '';
  if (text === existing) throw unprocessable(text ? 'The note already says that.' : 'There is no note on this day to remove.', { text: text ? 'The note already says that.' : 'There is no note to remove.' });

  const at = now.toISOString();
  await applyToDay({ employeeId, date, assignmentId: assignmentIdOn(read.person, date), change: {}, note: text ? { text, by: ctx.employee.id, byName: ctx.employee.name, at } : null, kind: 'note', by: ctx.employee, at, reason: '' });
  await recordAudit(ctx, { action: text ? 'attendance.note.set' : 'attendance.note.removed', targetType: 'attendance_day', targetId: attendanceId(employeeId, date), employeeId, summary: text ? `Left a note on ${target.name}'s ${date}.` : `Removed the note on ${target.name}'s ${date}.`, before: { note: existing || null }, after: { note: text || null }, selfAdministered });
  return dayDetail(ctx, employeeId, date);
}
