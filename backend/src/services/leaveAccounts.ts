import {
  balanceOf,
  daysInWords,
  dueEntries,
  EMPTY_ACCOUNT,
  leaveAccountId,
  leaveYearLabel,
  leaveYearOf,
  leaveYearRange,
  ownRecordVerdict,
  REASON_MAX,
  REASON_MIN,
  type AccountEntry,
  type AccountFacts,
  type LeaveAdjustmentInput,
  type LeaveBalanceRow,
  type LeaveBalancesPayload,
  type LeaveBooking,
  type LeavePolicy,
  type LeaveType,
  type LocalDate,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, fromDoc, isDuplicateKey, type Account, type LeaveAccountDoc, type LeavePolicyDoc } from '../db';
import type { RequestContext } from '../http/context';
import { conflict, notFound, unprocessable } from '../http/errors';
import { assertInScope, guardOwnRecord, loadOrg } from './access';
import { recordAudit } from './audit';
import { loadLeaveTypes } from './leaveStore';
import { todayFor } from './schedules';
import { loadCompany } from './settings';

/*
 * Leave accounts (plan.md, sections 5.3 and 7.2).
 *
 * One document per person per leave year holds everything a balance is made of: what was
 * added (the allowance, what was carried forward, HR's adjustments) and what live requests
 * hold or have taken. No total is stored anywhere.
 *
 * Every change that depends on what the account says (may this request have these days? may
 * this adjustment take these off?) is ONE write that names the version of the account it was
 * worked out from. If someone else wrote the account in between, the write does not go
 * through, and everything is read and worked out again. So two requests sent at the same
 * instant cannot both pass a check that only one of them should.
 */

export const toPolicy = ({ nameKey: _key, ...doc }: LeavePolicyDoc): LeavePolicy => fromDoc<LeavePolicy>(doc);

/** Everything needed to read or change one person's leave accounts, fetched at one moment. */
export interface Holder {
  employee: Account;
  /** The policy they are on now. */
  policy: LeavePolicy | null;
  types: LeaveType[];
  startMonth: number;
  /** Today's date for them. */
  today: LocalDate;
  /** The leave year today falls in for them. */
  currentYear: number;
  /** The day they joined: what eligibility and a pro-rated first year are counted from. */
  serviceStart: LocalDate | null;
  /** Their accounts as stored, by leave year. */
  stored: Map<number, LeaveAccountDoc>;
}

/** The joining date HR recorded, or failing that the first day attendance counted for them. */
export const serviceStartOf = (employee: Pick<Account, 'joinDate' | 'employment'>): LocalDate | null => employee.joinDate ?? [...employee.employment].sort((a, b) => (a.from < b.from ? -1 : 1))[0]?.from ?? null;

export async function holderOf(employee: Account, today?: LocalDate): Promise<Holder> {
  const [policy, types, company, accounts, day] = await Promise.all([
    employee.leavePolicyId ? db().leavePolicies.findOne({ _id: employee.leavePolicyId }) : null,
    loadLeaveTypes(),
    loadCompany(),
    db().leaveAccounts.find({ employeeId: employee.id }).toArray(),
    today ?? todayFor(employee.id),
  ]);
  return {
    employee,
    policy: policy ? toPolicy(policy) : null,
    types,
    startMonth: company.leaveYearStartMonth,
    today: day,
    currentYear: leaveYearOf(day, company.leaveYearStartMonth),
    serviceStart: serviceStartOf(employee),
    stored: new Map(accounts.map((account) => [account.leaveYear, account])),
  };
}

const factsOf = (doc: LeaveAccountDoc | undefined): AccountFacts => (doc ? { entries: doc.entries, bookings: doc.bookings, carried: doc.carried } : EMPTY_ACCOUNT);

/**
 * Last year's account as it stands, to carry forward from. There is one only where leave has
 * been kept for the person at least that long: an account is opened when someone is put on a
 * policy, so nobody starts with days "left over" from years before leave was kept at all.
 */
function previousOf(holder: Holder, year: number, at: string): AccountFacts | null {
  const earliest = Math.min(...holder.stored.keys());
  return year - 1 >= earliest ? viewOf(holder, year - 1, at) : null;
}

/** What an account is owed now: the shared \`dueEntries\`, given what this file knows. */
function dueFor(holder: Holder, year: number, at: string) {
  const stored = holder.stored.get(year);
  const account = factsOf(stored);
  // A year that is over and has its account is closed: a kind of leave added to the policy since is not granted for it.
  const closed = stored !== undefined && year < holder.currentYear;
  return dueEntries(account, { policy: holder.policy, types: holder.types, year, startMonth: holder.startMonth, today: holder.today, serviceStart: holder.serviceStart, previous: account.carried ? null : previousOf(holder, year, at), closed, at });
}

/** An account as it reads now: what is stored, with what it is owed added in. */
export function viewOf(holder: Holder, year: number, at: string): AccountFacts {
  const account = factsOf(holder.stored.get(year));
  const due = dueFor(holder, year, at);
  return { entries: [...account.entries, ...due.entries], bookings: account.bookings, carried: due.carried };
}

/** The leave years a person's account can be looked at for: every stored one, this one and the next. */
export const yearsOf = (holder: Holder): number[] => [...new Set([...holder.stored.keys(), holder.currentYear, holder.currentYear + 1])].sort((a, b) => a - b);

export interface AccountChange<T> {
  /** Entries to add (an adjustment). */
  entries?: AccountEntry[];
  /** A booking to add (a request's days, held). */
  booking?: LeaveBooking;
  result: T;
}

const MAX_ATTEMPTS = 60;
const pause = (attempt: number) => new Promise((resolve) => setTimeout(resolve, Math.random() * 12 * Math.min(attempt + 1, 6)));

/**
 * The one versioned write to an account.
 *
 * \`change\` is handed the account as it reads now and answers what to add to it, or throws to
 * refuse. Whatever the account is owed (the year's grant, the carry-forward) is written with
 * it. The write goes through only if the account is still at the version that was read;
 * otherwise the person, their policy and the account are read again and \`change\` is asked
 * again. \`change\` may therefore run several times and must not do anything but decide.
 *
 * @param year a leave year, or 'current' for the one today falls in for the person
 */
export async function writeAccount<T>(employeeId: string, year: number | 'current', change: (view: AccountFacts, holder: Holder, year: number) => AccountChange<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const doc = await db().employees.findOne({ _id: employeeId });
    if (!doc) throw notFound('That person does not exist.');
    const holder = await holderOf(fromDoc<Account>(doc));
    const leaveYear = year === 'current' ? holder.currentYear : year;
    if (!yearsOf(holder).includes(leaveYear)) throw unprocessable('There is no leave account for that year.', { leaveYear: 'Choose this leave year or the next.' });
    const at = clock.nowIso();
    const stored = holder.stored.get(leaveYear);
    const due = dueFor(holder, leaveYear, at);
    const base = factsOf(stored);
    const out = change({ entries: [...base.entries, ...due.entries], bookings: base.bookings, carried: due.carried }, holder, leaveYear);
    const entries = [...due.entries, ...(out.entries ?? [])];

    if (stored) {
      if (entries.length === 0 && !out.booking && stored.carried === due.carried) return out.result;
      const written = await db().leaveAccounts.updateOne(
        { _id: stored._id, version: stored.version },
        {
          ...(entries.length > 0 || out.booking ? { $push: { ...(entries.length > 0 ? { entries: { $each: entries } } : {}), ...(out.booking ? { bookings: out.booking } : {}) } } : {}),
          $set: { carried: due.carried, updatedAt: at },
          $inc: { version: 1 },
        },
      );
      if (written.modifiedCount === 1) return out.result;
    } else {
      if (entries.length === 0 && !out.booking) return out.result;
      try {
        await db().leaveAccounts.insertOne({ _id: leaveAccountId(employeeId, leaveYear), employeeId, leaveYear, entries, bookings: out.booking ? [out.booking] : [], carried: due.carried, version: 1, createdAt: at, updatedAt: at });
        return out.result;
      } catch (error) {
        // Someone else opened the account at the same moment: read it and work it out again.
        if (!isDuplicateKey(error)) throw error;
      }
    }
    await pause(attempt);
  }
  throw conflict('Their leave account is being changed by several requests at once. Try again in a moment.');
}

/** Opens the current leave year's account, so that the year's grant is made under the policy as it is now. */
export const openAccount = (employeeId: string) => writeAccount(employeeId, 'current', () => ({ result: null }));

/**
 * Makes a request's booking read \`held\` or \`taken\`. A booking that is already so, or is no
 * longer there, is left alone: running this twice changes nothing the second time.
 */
export async function markBooking(employeeId: string, leaveYear: number, requestId: string, state: LeaveBooking['state']) {
  await db().leaveAccounts.updateOne({ _id: leaveAccountId(employeeId, leaveYear), bookings: { $elemMatch: { requestId, state: { $ne: state } } } }, { $set: { 'bookings.$.state': state, updatedAt: clock.nowIso() }, $inc: { version: 1 } });
}

/** Takes a request's booking out of the account: its days are simply available again. Safe to run twice. */
export async function removeBooking(employeeId: string, leaveYear: number, requestId: string) {
  await db().leaveAccounts.updateOne({ _id: leaveAccountId(employeeId, leaveYear), 'bookings.requestId': requestId }, { $pull: { bookings: { requestId } }, $set: { updatedAt: clock.nowIso() }, $inc: { version: 1 } });
}

/** One kind of leave after another, for someone's account: the kinds in their policy, and any other the account holds something of. */
export function balanceRows(holder: Holder, view: AccountFacts): LeaveBalanceRow[] {
  const inPolicy = new Map((holder.policy?.entries ?? []).map((entry) => [entry.leaveTypeId, entry]));
  const used = new Set([...view.entries.map((e) => e.leaveTypeId), ...view.bookings.map((b) => b.leaveTypeId)]);
  return holder.types
    .filter((type) => used.has(type.id) || (!type.archived && inPolicy.has(type.id)))
    .map((type) => ({ type, entry: type.archived ? null : (inPolicy.get(type.id) ?? null), balance: balanceOf(view, type.id) }));
}

async function targetOf(ctx: RequestContext, employeeId: string): Promise<Account> {
  if (employeeId === ctx.employee.id) return ctx.employee;
  const doc = await db().employees.findOne({ _id: employeeId });
  if (!doc) throw notFound('That person does not exist.');
  return fromDoc<Account>(doc);
}

/** One person's leave account for a leave year, read now. Their own, or anyone the caller may see. Nothing is written. */
export async function balancesFor(ctx: RequestContext, employeeId: string, asked?: number): Promise<LeaveBalancesPayload> {
  await assertInScope(ctx, employeeId);
  const target = await targetOf(ctx, employeeId);
  const holder = await holderOf(target);
  const years = yearsOf(holder);
  const year = asked ?? holder.currentYear;
  if (!years.includes(year)) throw notFound('There is no leave account for that year.');

  const view = viewOf(holder, year, clock.nowIso());
  const typeName = new Map(holder.types.map((type) => [type.id, type.name]));
  const adjustable = year === holder.currentYear || year === holder.currentYear + 1;
  return {
    employee: { id: target.id, code: target.code, name: target.name },
    leaveYear: year,
    yearLabel: leaveYearLabel(year, holder.startMonth),
    range: leaveYearRange(year, holder.startMonth),
    currentYear: holder.currentYear,
    years: years.map((y) => ({ year: y, label: leaveYearLabel(y, holder.startMonth) })),
    today: holder.today,
    policy: holder.policy ? { id: holder.policy.id, name: holder.policy.name, approver: holder.policy.approver } : null,
    rows: balanceRows(holder, view),
    entries: view.entries.map((entry) => ({ ...entry, typeName: typeName.get(entry.leaveTypeId) ?? 'Leave' })),
    canAdjust: ctx.can('leave.configure') && adjustable && ownRecordVerdict(ctx.employee, [employeeId], await loadOrg()) !== 'blocked',
  };
}

/**
 * HR adds days to someone's account or takes days off it, with the reason. One versioned
 * write, like a request: an adjustment cannot take away days that a request arriving at the
 * same moment is being given. Never on their own account.
 */
export async function adjustLeave(ctx: RequestContext, input: LeaveAdjustmentInput): Promise<LeaveBalancesPayload> {
  await assertInScope(ctx, input.employeeId);
  const { selfAdministered } = await guardOwnRecord(ctx, [input.employeeId]);

  const fields: Record<string, string> = {};
  const note = input.note.trim();
  if (note.length < REASON_MIN) fields.note = 'Say why, in a few words.';
  else if (note.length > REASON_MAX) fields.note = `Keep this to ${REASON_MAX} characters or fewer.`;
  if (!Number.isFinite(input.days) || input.days === 0 || !Number.isInteger(input.days * 2) || Math.abs(input.days) > 366) fields.days = 'Give the days to add or take off, in whole or half days: 2, 0.5, -1.';
  if (Object.keys(fields).length > 0) throw unprocessable(Object.values(fields)[0]!, fields);

  const target = await targetOf(ctx, input.employeeId);
  const done = await writeAccount(input.employeeId, input.leaveYear, (view, holder, year) => {
    if (year !== holder.currentYear && year !== holder.currentYear + 1) throw unprocessable('A balance can be adjusted for this leave year and the next.', { leaveYear: 'Choose this leave year or the next.' });
    const type = holder.types.find((t) => t.id === input.leaveTypeId);
    if (!type) throw unprocessable('That kind of leave no longer exists.', { leaveTypeId: 'That kind of leave no longer exists.' });
    const before = balanceOf(view, type.id);
    const after = before.available + input.days;
    const mayGoBelow = !type.paid || Boolean(holder.policy?.entries.find((e) => e.leaveTypeId === type.id)?.allowNegative);
    if (input.days < 0 && after < 0 && !mayGoBelow) {
      const message = `They have ${daysInWords(Math.max(0, before.available))} of ${type.name} available${before.held > 0 ? ` (${daysInWords(before.held)} more held by requests still waiting)` : ''}, so ${daysInWords(-input.days)} cannot be taken off.`;
      throw unprocessable(message, { days: message });
    }
    const entry: AccountEntry = { kind: 'adjustment', leaveTypeId: type.id, days: input.days, note, by: ctx.employee.id, byName: ctx.employee.name, at: clock.nowIso() };
    return { entries: [entry], result: { type, before, year, label: leaveYearLabel(year, holder.startMonth) } };
  });

  await recordAudit(ctx, {
    action: 'leave.adjusted',
    targetType: 'leave_account',
    targetId: leaveAccountId(input.employeeId, done.year),
    employeeId: input.employeeId,
    summary: `${input.days > 0 ? 'Added' : 'Took off'} ${daysInWords(Math.abs(input.days))} of ${done.type.name} ${input.days > 0 ? 'to' : 'from'} ${target.name}'s leave for ${done.label}: ${note}`,
    before: { balance: done.before.balance, available: done.before.available },
    after: { days: input.days, balance: done.before.balance + input.days, available: done.before.available + input.days, note },
    selfAdministered,
  });
  return balancesFor(ctx, input.employeeId, done.year);
}
