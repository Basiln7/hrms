/*
 * Leave (plan.md, section 7).
 *
 * HR sets up kinds of leave and named policies; each person is on one policy. A person has one
 * leave account per leave year, holding two lists: entries (the year's allowance, what was
 * carried forward, HR's adjustments) and bookings (one per live request: held while it waits,
 * taken once approved). A balance is always worked out from those two lists and never stored,
 * so it cannot drift from what happened.
 *
 * Everything here is a plain function: which leave year a date is in, what an account is
 * owed, how many days a request uses, whether it may be sent, who may decide or cancel it, and
 * what leave means for one calendar day. The API enforces with these; the web app explains
 * with the same code.
 */
import { shapeOf, type DayContext, type LeaveOnDay, type LeavePart } from './attendance';
import { approvalVerdict, REASON_MAX, REASON_MIN, type ApprovalVerdict, type RequestStatus } from './corrections';
import { addDays, dayInWords, daysBetween, isLocalDate, MONTH_NAMES, type LocalDate } from './dates';
import type { OrgNode, OwnRecordVerdict } from './org';
import { can } from './roles';

// ── Kinds of leave ──────────────────────────────────────────────────────────

/** The colours a kind of leave can be shown in. Each is a colour of the theme, so it reads in light and dark. */
export const LEAVE_TONES = ['teal', 'blue', 'green', 'amber', 'violet', 'pink', 'orange', 'red', 'slate'] as const;
export type LeaveTone = (typeof LEAVE_TONES)[number];

export const LEAVE_TONE_COLOR: Record<LeaveTone, string> = {
  teal: 'var(--accent-text)',
  blue: 'var(--blue)',
  green: 'var(--green)',
  amber: 'var(--amber)',
  violet: 'var(--violet)',
  pink: 'var(--pink)',
  orange: 'var(--orange)',
  red: 'var(--red)',
  slate: 'var(--text-3)',
};

export interface LeaveType {
  id: string;
  name: string;
  /** A short code for tables and exports: CL, SL. */
  code: string;
  /** Unpaid leave needs no balance and is counted apart in the month's summary. */
  paid: boolean;
  allowHalfDay: boolean;
  tone: LeaveTone;
  /** No longer offered. Leave already booked under it stays as it is. */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type LeaveTypeInput = Pick<LeaveType, 'name' | 'code' | 'paid' | 'allowHalfDay' | 'tone'>;

export const LEAVE_NAME_MAX = 40;
export const LEAVE_CODE_PATTERN = /^[A-Z0-9]{2,6}$/;

/** Field-by-field problems with a kind of leave; empty when it is fine. */
export function validateLeaveType(input: LeaveTypeInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 2) errors.name = 'Give this kind of leave a name.';
  else if (name.length > LEAVE_NAME_MAX) errors.name = `Keep this to ${LEAVE_NAME_MAX} characters or fewer.`;
  if (!LEAVE_CODE_PATTERN.test(input.code.trim().toUpperCase())) errors.code = 'Use 2 to 6 letters or digits, for example CL.';
  if (typeof input.paid !== 'boolean') errors.paid = 'Say whether it is paid.';
  if (typeof input.allowHalfDay !== 'boolean') errors.allowHalfDay = 'Say whether a half-day can be taken.';
  if (!LEAVE_TONES.includes(input.tone)) errors.tone = 'Choose a colour.';
  return errors;
}

// ── Policies ────────────────────────────────────────────────────────────────

/** A policy's rules for one kind of leave. Every number is HR's to set; none is fixed in the code. */
export interface PolicyEntry {
  leaveTypeId: string;
  /** Days granted for a whole leave year. */
  annualDays: number;
  /** Someone who joins part of the way through a leave year gets the share of the months that are left. */
  prorateFirstYear: boolean;
  /** How many unused days go over into the next leave year at most. 0: none do. */
  carryForwardMax: number;
  /** Days of service before this leave can be taken. 0: from the first day. */
  eligibleAfterDays: number;
  /** The longest run of working days in a row. Null: no limit. */
  maxConsecutiveDays: number | null;
  /** How many days ahead it has to be asked for. 0: no notice. */
  minNoticeDays: number;
  /** How many days back it may start, for leave asked for after the fact (sick leave, say). 0: not at all. */
  backdateDays: number;
  /** Whether more may be taken than is left. */
  allowNegative: boolean;
}

/** Who decides a request: the person's manager chain (HR and Admin can always act), or HR and Admin only. */
export type LeaveApprover = 'manager' | 'hr';

export const LEAVE_APPROVER_LABEL: Record<LeaveApprover, string> = { manager: 'Their manager, or HR', hr: 'HR only' };

/** Who approves, inside a sentence: "your manager, or HR", "HR only". */
export const approverInWords = (approver: LeaveApprover, whose: 'your' | 'their'): string => (approver === 'manager' ? `${whose} manager, or HR` : 'HR only');

export interface LeavePolicy {
  id: string;
  name: string;
  approver: LeaveApprover;
  entries: PolicyEntry[];
  createdAt: string;
  updatedAt: string;
}

export type LeavePolicyInput = Pick<LeavePolicy, 'name' | 'approver' | 'entries'>;

export const POLICY_NAME_MAX = 60;
export const LEAVE_DAYS_MAX = 366;

/** The entry a new policy starts with for a kind of leave: nothing granted, nothing limited. */
export const startingEntry = (leaveTypeId: string): PolicyEntry => ({ leaveTypeId, annualDays: 0, prorateFirstYear: true, carryForwardMax: 0, eligibleAfterDays: 0, maxConsecutiveDays: null, minNoticeDays: 0, backdateDays: 0, allowNegative: false });

const isHalfStep = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && Number.isInteger(value * 2);
const isWhole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * Field-by-field problems with a policy; empty when it is fine. An entry's problems are named
 * `entries.<leave type id>.<field>`, so a form can put each message beside its field.
 */
export function validateLeavePolicy(input: LeavePolicyInput, types: readonly Pick<LeaveType, 'id'>[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 2) errors.name = 'Give the policy a name.';
  else if (name.length > POLICY_NAME_MAX) errors.name = `Keep this to ${POLICY_NAME_MAX} characters or fewer.`;
  if (input.approver !== 'manager' && input.approver !== 'hr') errors.approver = 'Choose who approves.';
  if (input.entries.length === 0) errors.entries = 'Include at least one kind of leave.';

  const known = new Set(types.map((t) => t.id));
  const seen = new Set<string>();
  for (const entry of input.entries) {
    const at = (field: string) => `entries.${entry.leaveTypeId}.${field}`;
    if (!known.has(entry.leaveTypeId)) errors[at('leaveTypeId')] = 'That kind of leave no longer exists.';
    else if (seen.has(entry.leaveTypeId)) errors[at('leaveTypeId')] = 'A kind of leave is in a policy once.';
    seen.add(entry.leaveTypeId);
    if (!isHalfStep(entry.annualDays, 0, LEAVE_DAYS_MAX)) errors[at('annualDays')] = `Give days from 0 to ${LEAVE_DAYS_MAX}, in whole or half days.`;
    if (!isHalfStep(entry.carryForwardMax, 0, LEAVE_DAYS_MAX)) errors[at('carryForwardMax')] = `Give days from 0 to ${LEAVE_DAYS_MAX}, in whole or half days. 0 carries nothing forward.`;
    if (!isWhole(entry.eligibleAfterDays, 0, 3650)) errors[at('eligibleAfterDays')] = 'Give a whole number of days from 0 to 3650.';
    if (entry.maxConsecutiveDays !== null && !isHalfStep(entry.maxConsecutiveDays, 0.5, LEAVE_DAYS_MAX)) errors[at('maxConsecutiveDays')] = 'Give at least half a day, or leave it empty for no limit.';
    if (!isWhole(entry.minNoticeDays, 0, 365)) errors[at('minNoticeDays')] = 'Give a whole number of days from 0 to 365.';
    if (!isWhole(entry.backdateDays, 0, 365)) errors[at('backdateDays')] = 'Give a whole number of days from 0 to 365.';
    else if (entry.backdateDays > 0 && isWhole(entry.minNoticeDays, 1, 365)) errors[at('backdateDays')] = 'Leave that needs notice cannot also start in the past. Set one of the two to 0.';
    if (typeof entry.prorateFirstYear !== 'boolean') errors[at('prorateFirstYear')] = 'Say whether a first year is pro-rated.';
    if (typeof entry.allowNegative !== 'boolean') errors[at('allowNegative')] = 'Say whether the balance may go below zero.';
  }
  return errors;
}

// ── The leave year ──────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The leave year a date falls in, named by the calendar year it starts in. With a leave year
 * that starts in April, 10 February 2027 is in leave year 2026.
 */
export function leaveYearOf(date: LocalDate, startMonth: number): number {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= startMonth ? year : year - 1;
}

/** The first and last day of a leave year. */
export function leaveYearRange(year: number, startMonth: number): { from: LocalDate; to: LocalDate } {
  const first = (y: number) => `${String(y).padStart(4, '0')}-${pad(startMonth)}-01`;
  return { from: first(year), to: addDays(first(year + 1), -1) };
}

/** "2026", or "Apr 2026 to Mar 2027" when the leave year does not start in January. */
export function leaveYearLabel(year: number, startMonth: number): string {
  if (startMonth === 1) return String(year);
  return `${MONTH_NAMES[startMonth - 1]!.slice(0, 3)} ${year} to ${MONTH_NAMES[(startMonth + 10) % 12]!.slice(0, 3)} ${year + 1}`;
}

// ── Accounts and balances ───────────────────────────────────────────────────

export type AccountEntryKind = 'grant' | 'carry_forward' | 'adjustment';

export const ENTRY_KIND_LABEL: Record<AccountEntryKind, string> = { grant: 'Allowance', carry_forward: 'Carried forward', adjustment: 'Adjustment' };

/** Days added to an account, or taken off it (an adjustment may be negative). */
export interface AccountEntry {
  kind: AccountEntryKind;
  leaveTypeId: string;
  days: number;
  /** Why: for an adjustment, HR's reason. */
  note: string;
  /** Who made it. Null for what the system grants by itself. */
  by: string | null;
  byName: string;
  at: string;
}

/** The days one live request holds or has taken. */
export interface LeaveBooking {
  requestId: string;
  leaveTypeId: string;
  startDate: LocalDate;
  endDate: LocalDate;
  dayPart: LeavePart;
  days: number;
  /** `held` while the request waits; `taken` once it is approved. */
  state: 'held' | 'taken';
}

/** The two lists a balance is worked out from. */
export interface AccountFacts {
  entries: readonly AccountEntry[];
  bookings: readonly LeaveBooking[];
  /** Whether last year's unused days have been brought over. Done once, and only once the year has begun. */
  carried: boolean;
}

export const EMPTY_ACCOUNT: AccountFacts = { entries: [], bookings: [], carried: false };

/** One person's leave for one leave year. */
export interface LeaveAccount extends AccountFacts {
  employeeId: string;
  leaveYear: number;
  /** Goes up with every write. A write names the version it read, so two at once cannot both go through. */
  version: number;
}

export const leaveAccountId = (employeeId: string, leaveYear: number) => `${employeeId}|${leaveYear}`;

export interface TypeBalance {
  leaveTypeId: string;
  /** The year's allowance. */
  granted: number;
  carriedForward: number;
  /** HR's adjustments, added up. May be negative. */
  adjusted: number;
  /** Approved leave. */
  taken: number;
  /** Requests still waiting. */
  held: number;
  /** What is left: everything added, less what was taken. */
  balance: number;
  /** What can still be asked for: the balance, less what waiting requests hold. */
  available: number;
}

/** One kind of leave in an account, added up. Nothing here is ever stored. */
export function balanceOf(account: AccountFacts, leaveTypeId: string): TypeBalance {
  const sum = (kind: AccountEntryKind) => account.entries.filter((e) => e.leaveTypeId === leaveTypeId && e.kind === kind).reduce((total, e) => total + e.days, 0);
  const booked = (state: LeaveBooking['state']) => account.bookings.filter((b) => b.leaveTypeId === leaveTypeId && b.state === state).reduce((total, b) => total + b.days, 0);
  const granted = sum('grant');
  const carriedForward = sum('carry_forward');
  const adjusted = sum('adjustment');
  const taken = booked('taken');
  const held = booked('held');
  const balance = granted + carriedForward + adjusted - taken;
  return { leaveTypeId, granted, carriedForward, adjusted, taken, held, balance, available: balance - held };
}

/** Half a day is the smallest amount of leave. Rounded down, so nothing is granted that was not earned. */
export const floorToHalf = (days: number): number => Math.floor(days * 2 + 1e-9) / 2;

/**
 * The allowance for a leave year. Someone who was there on its first day, or whose joining
 * date is not known, gets all of it. Someone who joins during it gets, where the policy says
 * so, the share of the months left, the month of joining counted whole. Someone who joins
 * after it gets nothing.
 *
 * @param serviceStart the day they joined
 */
export function grantDays(entry: Pick<PolicyEntry, 'annualDays' | 'prorateFirstYear'>, serviceStart: LocalDate | null, year: { from: LocalDate; to: LocalDate }): number {
  if (!serviceStart || serviceStart <= year.from) return entry.annualDays;
  if (serviceStart > year.to) return 0;
  if (!entry.prorateFirstYear) return entry.annualDays;
  const months = (Number(year.to.slice(0, 4)) - Number(serviceStart.slice(0, 4))) * 12 + Number(year.to.slice(5, 7)) - Number(serviceStart.slice(5, 7)) + 1;
  return floorToHalf((entry.annualDays * months) / 12);
}

/** "23 Nov 2026" for a calendar day, for the notes the system writes into an account. */
const shortDay = (date: LocalDate) => `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]!.slice(0, 3)} ${Number(date.slice(0, 4))}`;

export interface DueInput {
  /** The policy the person is on now. Null: on none, so nothing is granted. */
  policy: Pick<LeavePolicy, 'entries'> | null;
  /** The kinds of leave. An archived one is granted nothing new. */
  types: readonly Pick<LeaveType, 'id' | 'archived'>[];
  year: number;
  startMonth: number;
  /** Today's date for the person. */
  today: LocalDate;
  serviceStart: LocalDate | null;
  /** Last year's account as it stands now, or null when there is none to carry from. */
  previous: AccountFacts | null;
  /** The account is of a year that is over and was opened in its time: it is granted no new allowance. */
  closed?: boolean;
  at: string;
}

/**
 * What an account is still owed at a moment (plan.md, 7.2):
 *
 * - the year's allowance, for each kind of leave in the person's policy that has not had one
 *   yet. It is made once: a policy edited later changes what is granted from then on, never a
 *   grant already made;
 * - what is carried forward from last year, once, and only when the year has begun. Before
 *   that, days still to be carried could be spent in the old year as well.
 *
 * Shown balances include what is due. It is written into the account with the first change
 * made to it (a request, an adjustment).
 */
export function dueEntries(account: AccountFacts, o: DueInput): { entries: AccountEntry[]; carried: boolean } {
  const range = leaveYearRange(o.year, o.startMonth);
  const label = leaveYearLabel(o.year, o.startMonth);
  const live = new Set(o.types.filter((t) => !t.archived).map((t) => t.id));
  const entries: AccountEntry[] = [];
  const system = { by: null, byName: 'Automatic', at: o.at };
  const policyEntries = (o.policy?.entries ?? []).filter((e) => live.has(e.leaveTypeId));

  for (const entry of o.closed ? [] : policyEntries) {
    if (account.entries.some((e) => e.kind === 'grant' && e.leaveTypeId === entry.leaveTypeId)) continue;
    const days = grantDays(entry, o.serviceStart, range);
    if (days <= 0) continue;
    const prorated = days < entry.annualDays;
    entries.push({ kind: 'grant', leaveTypeId: entry.leaveTypeId, days, note: `Allowance for ${label}${prorated && o.serviceStart ? `, pro-rated from ${shortDay(o.serviceStart)}` : ''}`, ...system });
  }

  const begun = o.today >= range.from;
  if (!account.carried && begun && o.previous) {
    for (const entry of policyEntries) {
      if (entry.carryForwardMax <= 0) continue;
      const left = balanceOf(o.previous, entry.leaveTypeId).available;
      const days = Math.min(entry.carryForwardMax, floorToHalf(Math.max(0, left)));
      if (days > 0) entries.push({ kind: 'carry_forward', leaveTypeId: entry.leaveTypeId, days, note: `Carried forward from ${leaveYearLabel(o.year - 1, o.startMonth)}`, ...system });
    }
  }
  return { entries, carried: account.carried || begun };
}

/** An account with what it is owed added in: how it reads now. */
export function withDue(account: AccountFacts, o: DueInput): AccountFacts {
  const due = dueEntries(account, o);
  return { entries: [...account.entries, ...due.entries], bookings: account.bookings, carried: due.carried };
}

// ── Counting the days of a request ──────────────────────────────────────────

export const LEAVE_PARTS: readonly LeavePart[] = ['full', 'first_half', 'second_half'];
export const LEAVE_PART_LABEL: Record<LeavePart, string> = { full: 'Full day', first_half: 'First half', second_half: 'Second half' };

export interface DayCount {
  /** What the request uses: one per working day, or a half for a half-day. */
  days: number;
  /** The dates counted. */
  charged: LocalDate[];
  /** The dates in the range that cost nothing, and why. */
  notCounted: { date: LocalDate; why: 'weekly_off' | 'holiday' | 'not_applicable'; name?: string }[];
}

/**
 * The days a request uses: only the person's own working days, by their own schedule and
 * holiday calendar as they stand now (plan.md, 7.3). Weekly offs and holidays inside the range
 * cost nothing. An optional holiday is a working day, so it is counted: taking it off is
 * exactly what leave is for.
 */
export function countLeaveDays(startDate: LocalDate, endDate: LocalDate, dayPart: LeavePart, ctx: DayContext): DayCount {
  const count: DayCount = { days: 0, charged: [], notCounted: [] };
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const shape = shapeOf(date, ctx);
    if (shape?.kind === 'working') count.charged.push(date);
    else count.notCounted.push({ date, why: shape?.kind ?? 'not_applicable', ...(shape?.holiday ? { name: shape.holiday.name } : {}) });
  }
  count.days = dayPart === 'full' ? count.charged.length : count.charged.length * 0.5;
  return count;
}

/** "1 day", "half a day", "2.5 days". */
export function daysInWords(days: number): string {
  if (days === 0.5) return 'half a day';
  if (days === -0.5) return 'minus half a day';
  return `${Math.round(days * 10) / 10} ${Math.abs(days) === 1 ? 'day' : 'days'}`;
}

/** The dates of a request in words: "Monday 14 December", "Monday 14 December, first half", "Monday 14 December to Wednesday 16 December". */
export function leaveDatesInWords(request: { startDate: LocalDate; endDate: LocalDate; dayPart: LeavePart }): string {
  if (request.startDate === request.endDate) return `${dayInWords(request.startDate)}${request.dayPart === 'full' ? '' : `, ${LEAVE_PART_LABEL[request.dayPart].toLowerCase()}`}`;
  return `${dayInWords(request.startDate)} to ${dayInWords(request.endDate)}`;
}

// ── Requests ────────────────────────────────────────────────────────────────

/** `submitting` is a request whose days are not held yet. It is shown to nobody. */
export type LeaveStatus = RequestStatus | 'submitting';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveYear: number;
  startDate: LocalDate;
  endDate: LocalDate;
  dayPart: LeavePart;
  /** What it uses, as counted when it was sent. It does not change afterwards. */
  days: number;
  /** The dates that were counted. */
  charged: LocalDate[];
  reason: string;
  /** Who decides it, as the person's policy said when it was sent. */
  approver: LeaveApprover;
  status: LeaveStatus;
  /** False while the account does not yet match the status. Settling again changes nothing. */
  settled: boolean;
  submittedAt: string;
  decidedBy: string | null;
  /** A snapshot, so the record still reads after a rename. */
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
}

/** What the employee fills in. */
export interface LeaveRequestInput {
  leaveTypeId: string;
  startDate: LocalDate;
  endDate: LocalDate;
  dayPart: LeavePart;
  reason: string;
}

type Span = Pick<LeaveBooking, 'startDate' | 'endDate' | 'dayPart'>;

/** Whether two requests claim the same time. Two different halves of one day sit side by side. */
export function spansOverlap(a: Span, b: Span): boolean {
  if (a.endDate < b.startDate || b.endDate < a.startDate) return false;
  // A half-day is always a single date, so two halves that meet are on the same date.
  return !(a.dayPart !== 'full' && b.dayPart !== 'full' && a.dayPart !== b.dayPart);
}

/** How far apart two bookings may lie and still be looked at as one run. Beyond it they are not. */
const RUN_GAP_DAYS = 31;

/** Whether a working day lies strictly between two dates. */
function workingDayBetween(after: LocalDate, before: LocalDate, ctx: DayContext): boolean {
  if (daysBetween(after, before) > RUN_GAP_DAYS) return true;
  for (let date = addDays(after, 1); date < before; date = addDays(date, 1)) if (shapeOf(date, ctx)?.kind === 'working') return true;
  return false;
}

/**
 * The run of working days a request would make together with leave of the same kind that
 * touches it: booked right before or right after, with no working day in between. Without
 * this, a limit of three days in a row could be passed by asking twice.
 */
export function runLength(span: Span & { days: number }, sameKind: readonly LeaveBooking[], ctx: DayContext): number {
  let total = span.days;
  let from = span.startDate;
  let to = span.endDate;
  const rest = [...sameKind];
  for (let grew = true; grew; ) {
    grew = false;
    for (const [index, booking] of rest.entries()) {
      const before = booking.endDate < from && !workingDayBetween(booking.endDate, from, ctx);
      const after = booking.startDate > to && !workingDayBetween(to, booking.startDate, ctx);
      // A booking inside the run already (the other half of a day at its edge) joins it too.
      const inside = booking.startDate >= from && booking.endDate <= to;
      if (!before && !after && !inside) continue;
      total += booking.days;
      if (booking.startDate < from) from = booking.startDate;
      if (booking.endDate > to) to = booking.endDate;
      rest.splice(index, 1);
      grew = true;
      break;
    }
  }
  return total;
}

function reasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REASON_MIN) return 'Say why, in a few words.';
  if (length > REASON_MAX) return `Keep this to ${REASON_MAX} characters or fewer.`;
  return null;
}

export interface LeaveCheckContext {
  /** Today's date for the person. */
  today: LocalDate;
  startMonth: number;
  /** The kind of leave asked for, or null when it does not exist. */
  type: LeaveType | null;
  /** Whether the person is on a leave policy at all. */
  hasPolicy: boolean;
  /** Their policy's rules for that kind, or null when the policy does not include it. */
  entry: PolicyEntry | null;
  /** The account of the leave year the request starts in, with what it is owed. */
  account: AccountFacts;
  /** Their schedule and holidays, as they stand now. */
  ctx: DayContext;
  /** The day they joined. */
  serviceStart: LocalDate | null;
}

export interface LeaveCheck {
  /** What is wrong, by field. Empty when the request may be sent. */
  errors: Record<string, string>;
  /** The leave year the request lies in, once its dates are sound. */
  leaveYear: number | null;
  /** The days it uses, once its dates are sound. */
  count: DayCount | null;
  /** What it does to the balance, once the kind of leave is known. `unlimited`: the kind needs no balance. */
  balance: { available: number; after: number; unlimited: boolean } | null;
}

/**
 * Checks a request against the person's policy, schedule and account as they are now
 * (plan.md, 7.3). The same function answers the preview on the form, the check when the
 * request is sent, and the check inside the one write that holds the days, so the three can
 * never disagree.
 */
export function checkLeaveRequest(input: LeaveRequestInput, c: LeaveCheckContext, options: { reason: boolean } = { reason: true }): LeaveCheck {
  const errors: Record<string, string> = {};
  const result: LeaveCheck = { errors, leaveYear: null, count: null, balance: null };
  if (options.reason) {
    const reason = reasonError(input.reason);
    if (reason) errors.reason = reason;
  }

  const { type, entry } = c;
  if (!type || type.archived) errors.leaveTypeId = 'Choose a kind of leave.';
  else if (!c.hasPolicy) errors.leaveTypeId = 'You are not on a leave policy yet, so there is no leave to ask for. Ask HR.';
  else if (!entry) errors.leaveTypeId = `Your leave policy does not include ${type.name}.`;

  if (!isLocalDate(input.startDate)) errors.startDate = 'Choose the first day.';
  if (!isLocalDate(input.endDate)) errors.endDate = 'Choose the last day.';
  else if (!errors.startDate && input.endDate < input.startDate) errors.endDate = 'The last day cannot be before the first.';
  if (!LEAVE_PARTS.includes(input.dayPart)) errors.dayPart = 'Choose a full day or a half.';
  if (errors.startDate || errors.endDate || errors.dayPart) return result;

  const single = input.startDate === input.endDate;
  if (input.dayPart !== 'full' && !single) errors.dayPart = 'A half-day is for a single date. Choose one date, or the full days.';
  else if (input.dayPart !== 'full' && type && !type.allowHalfDay) errors.dayPart = `${type.name} cannot be taken as a half-day.`;

  // One request, one leave year: the account of that year is the single place it is checked against.
  const year = leaveYearOf(input.startDate, c.startMonth);
  const current = leaveYearOf(c.today, c.startMonth);
  if (leaveYearOf(input.endDate, c.startMonth) !== year) {
    errors.endDate = `A request stays inside one leave year, and a new one starts on ${dayInWords(leaveYearRange(year + 1, c.startMonth).from)}. Send two requests.`;
    return result;
  }
  if (year < current) errors.startDate = 'That leave year is over. Ask HR to put it right.';
  else if (year > current + 1) errors.startDate = 'That is too far ahead: leave can be asked for in this leave year and the next.';
  result.leaveYear = year;

  const count = countLeaveDays(input.startDate, input.endDate, input.dayPart, c.ctx);
  result.count = count;
  if (count.charged.length === 0 && !errors.startDate) {
    errors.startDate = c.ctx.rulesOn(input.startDate) || c.ctx.rulesOn(input.endDate) ? 'There is no working day for you in those dates, so there is nothing to take leave from.' : 'You have no work schedule on those dates, so there is nothing to take leave from.';
  }
  if (!type || !entry || errors.leaveTypeId) return result;

  const name = type.name;
  const booked = balanceOf(c.account, type.id);
  const unlimited = !type.paid || entry.allowNegative;
  result.balance = { available: booked.available, after: booked.available - count.days, unlimited };
  if (Object.keys(errors).length > 0) return result;

  if (entry.minNoticeDays > 0) {
    const earliest = addDays(c.today, entry.minNoticeDays);
    if (input.startDate < earliest) errors.startDate = `${name} has to be asked for ${entry.minNoticeDays} ${entry.minNoticeDays === 1 ? 'day' : 'days'} ahead: it can start on ${dayInWords(earliest)} at the earliest.`;
  } else {
    const earliest = addDays(c.today, -entry.backdateDays);
    if (input.startDate < earliest) errors.startDate = entry.backdateDays === 0 ? `${name} cannot start on a day that has passed.` : `${name} can start up to ${entry.backdateDays} ${entry.backdateDays === 1 ? 'day' : 'days'} back: from ${dayInWords(earliest)}.`;
  }

  if (!errors.startDate && entry.eligibleAfterDays > 0) {
    if (!c.serviceStart) errors.startDate = `${name} can be taken after ${entry.eligibleAfterDays} days of service, and your joining date is not recorded. Ask HR.`;
    else {
      const eligibleFrom = addDays(c.serviceStart, entry.eligibleAfterDays);
      if (input.startDate < eligibleFrom) errors.startDate = `You can take ${name} from ${dayInWords(eligibleFrom)}: ${entry.eligibleAfterDays} days after joining.`;
    }
  }

  const clash = c.account.bookings.find((booking) => spansOverlap(booking, input));
  if (clash && !errors.startDate) errors.startDate = `You already have leave ${clash.state === 'held' ? 'waiting for approval' : 'approved'} for ${leaveDatesInWords(clash)}.`;

  if (!errors.startDate && entry.maxConsecutiveDays !== null) {
    const run = runLength({ ...input, days: count.days }, c.account.bookings.filter((b) => b.leaveTypeId === type.id), c.ctx);
    if (run > entry.maxConsecutiveDays) {
      const more = run > count.days ? `, and with the ${name} you already have next to these dates this would make ${daysInWords(run)}` : `, and this is ${daysInWords(run)}`;
      errors.endDate = `${name} can be taken for ${daysInWords(entry.maxConsecutiveDays)} in a row at most${more}.`;
    }
  }

  if (Object.keys(errors).length === 0 && !unlimited && booked.available < count.days) {
    errors.leaveTypeId = `This needs ${daysInWords(count.days)} of ${name} and you have ${daysInWords(Math.max(0, booked.available))} available${booked.held > 0 ? ` (${daysInWords(booked.held)} held by requests still waiting)` : ''}.`;
  }
  return result;
}

// ── Who decides, who cancels ────────────────────────────────────────────────

/**
 * Whether someone may decide a leave request. The rules of every approval apply (never their
 * own; HR and Admin for anyone else; a manager for their chain, but never a request made by HR
 * or an Admin), and a request whose policy says "HR only" is not a manager's to decide.
 */
export function leaveApprovalVerdict(approver: Pick<OrgNode, 'id' | 'role'>, request: Pick<LeaveRequest, 'employeeId' | 'approver'>, people: readonly OrgNode[]): ApprovalVerdict {
  const verdict = approvalVerdict(approver, request.employeeId, people);
  if (verdict === 'allowed' && request.approver === 'hr' && !can(approver.role, 'requests.approveAll')) return 'not_theirs';
  return verdict;
}

export type CancelVerdict =
  | { allowed: true; /** Cancelled with an HR power, which needs a reason. */ byHr: boolean }
  | { allowed: false; reason: string; /** Not theirs to see at all: answered as if it did not exist. */ hidden: boolean };

/**
 * Whether someone may cancel a leave request (plan.md, 7.3).
 *
 * - Their own: while it waits, or after approval until its first day.
 * - From the first day on it is HR's, with a reason; and never their own, unless they are the
 *   only HR or Admin there is (`ownRecord`, plan.md D13).
 * - HR does not cancel a request that is still waiting: rejecting it is the way, and says why.
 *
 * @param today today's date for the person whose leave it is
 */
export function leaveCancelVerdict(request: Pick<LeaveRequest, 'employeeId' | 'status' | 'startDate'>, actor: Pick<OrgNode, 'id' | 'role'>, today: LocalDate, ownRecord: OwnRecordVerdict): CancelVerdict {
  const own = request.employeeId === actor.id;
  const hr = can(actor.role, 'requests.approveAll');
  if (!own && !hr) return { allowed: false, hidden: true, reason: 'That request does not exist.' };
  if (request.status !== 'pending' && request.status !== 'approved') return { allowed: false, hidden: false, reason: `That request is already ${request.status}.` };
  if (own) {
    if (request.status === 'pending' || today < request.startDate) return { allowed: true, byHr: false };
    if (hr && ownRecord === 'self_administered') return { allowed: true, byHr: true };
    return { allowed: false, hidden: false, reason: hr ? 'This leave has already started. Ask another HR or Admin to cancel it.' : 'This leave has already started, so only HR can cancel it now.' };
  }
  if (request.status === 'pending') return { allowed: false, hidden: false, reason: 'This request is still waiting for a decision. Reject it instead, and say why.' };
  return { allowed: true, byHr: true };
}

// ── Leave on one calendar day ───────────────────────────────────────────────

/** A request as the calendar needs it: its dates, whether it is approved yet, and what kind it is. */
export interface LeaveSpan {
  startDate: LocalDate;
  endDate: LocalDate;
  dayPart: LeavePart;
  status: 'pending' | 'approved';
  name: string;
  paid: boolean;
}

/**
 * The approved leave on a date, as the attendance engine takes it. An approved request covers
 * every date in its range (the engine applies it to working days only), whatever was counted
 * when it was sent: so a holiday moved afterwards never leaves a day reading Absent in the
 * middle of approved leave. Two halves approved for one date make a whole day.
 */
export function leaveOnDate(spans: readonly LeaveSpan[], date: LocalDate): LeaveOnDay | null {
  const on = spans.filter((s) => s.status === 'approved' && s.startDate <= date && date <= s.endDate);
  if (on.length === 0) return null;
  const full = on.find((s) => s.dayPart === 'full');
  const halves = new Set(on.filter((s) => s.dayPart !== 'full').map((s) => s.dayPart));
  const whole = Boolean(full) || halves.size === 2;
  const counted = full ? [full] : on;
  const unpaid = full ? (full.paid ? 0 : 1) : counted.filter((s) => !s.paid).length * 0.5;
  return {
    units: whole ? 1 : 0.5,
    part: whole ? 'full' : on[0]!.dayPart,
    name: [...new Set(counted.map((s) => s.name))].join(' + '),
    ...(unpaid > 0 ? { unpaidUnits: Math.min(1, unpaid) } : {}),
  };
}

/** Whether a leave request for a date is still waiting for a decision. */
export const leavePendingOn = (spans: readonly LeaveSpan[], date: LocalDate): boolean => spans.some((s) => s.status === 'pending' && s.startDate <= date && date <= s.endDate);

/** A leave request that a change to a holiday or a schedule touches, for whoever makes that change. */
export interface LeaveTouched {
  employeeName: string;
  typeName: string;
  startDate: LocalDate;
  endDate: LocalDate;
  dayPart: LeavePart;
  days: number;
  status: 'pending' | 'approved';
}

/**
 * Leave requests a change touches, in sentences. The days charged for a request stay as they
 * were counted; nothing is refunded or charged by itself (plan.md, 7.3).
 */
export function touchedInWords(touched: readonly LeaveTouched[]): string[] {
  if (touched.length === 0) return [];
  const lines = [`${touched.length === 1 ? 'One leave request includes' : `${touched.length} leave requests include`} these dates. The days already charged stay as they were counted: adjust the balance by hand where that is no longer right.`];
  for (const t of touched) lines.push(`${t.employeeName}: ${t.typeName}, ${leaveDatesInWords(t)} (${daysInWords(t.days)} charged, ${t.status === 'approved' ? 'approved' : 'waiting'}).`);
  return lines;
}
