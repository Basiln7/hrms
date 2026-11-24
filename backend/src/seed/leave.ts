import { addDays, can, startingEntry, type LeavePolicy, type LeaveType, type LeaveTypeInput, type LocalDate, type PolicyEntry } from '@delta-hrms/shared';
import { clock } from '../clock';
import { attendanceId, db, fromDoc, nameKey, toDoc, type Account } from '../db';
import type { RequestContext } from '../http/context';
import { newId } from '../ids';
import { approveLeave, submitLeave } from '../services/leave';
import { openAccount } from '../services/leaveAccounts';
import { saveDefaultPolicy } from '../services/leaveStore';

/*
 * Leave for the sample company: four kinds of leave, one policy that everyone is on, and a
 * few requests. The requests are made through the same services the API uses, as the people
 * themselves, so the sample accounts add up exactly as real ones do.
 */

export const DEMO_LEAVE_TYPES: readonly LeaveTypeInput[] = [
  { name: 'Casual leave', code: 'CL', paid: true, allowHalfDay: true, tone: 'blue' },
  { name: 'Earned leave', code: 'EL', paid: true, allowHalfDay: false, tone: 'green' },
  { name: 'Sick leave', code: 'SL', paid: true, allowHalfDay: true, tone: 'amber' },
  { name: 'Unpaid leave', code: 'LOP', paid: false, allowHalfDay: true, tone: 'slate' },
];

export const DEMO_POLICY = 'Standard leave';

/** The sample policy's rules, by leave code. Each one shows a different rule at work. */
const DEMO_RULES: Record<string, Partial<PolicyEntry>> = {
  CL: { annualDays: 12, maxConsecutiveDays: 3 },
  EL: { annualDays: 15, carryForwardMax: 10, minNoticeDays: 7, eligibleAfterDays: 90 },
  SL: { annualDays: 8, backdateDays: 7 },
  LOP: { annualDays: 0, backdateDays: 7 },
};

/** Stands in for a signed-in person, for the requests the sample people "make". */
const actingAs = (account: Account): RequestContext => ({ employee: account, session: { _id: 'seed', employeeId: account.id, createdAt: new Date(), expiresAt: new Date() }, can: (permission) => can(account.role, permission), ip: '' });

/** Creates the kinds of leave and the policy. Returns the policy's id, for the people who are put on it. */
export async function seedLeaveSetup(): Promise<string> {
  const now = clock.nowIso();
  const types: LeaveType[] = DEMO_LEAVE_TYPES.map((input) => ({ id: newId('lvt'), ...input, archived: false, createdAt: now, updatedAt: now }));
  await db().leaveTypes.insertMany(types.map((type) => ({ ...toDoc(type), nameKey: nameKey(type.name) })));
  const policy: LeavePolicy = { id: newId('lvp'), name: DEMO_POLICY, approver: 'manager', entries: types.map((type) => ({ ...startingEntry(type.id), ...DEMO_RULES[type.code] })), createdAt: now, updatedAt: now };
  await db().leavePolicies.insertOne({ ...toDoc(policy), nameKey: nameKey(policy.name) });
  await saveDefaultPolicy(policy.id);
  return policy.id;
}

/** Opens this leave year's account for everyone on a policy, and makes a few sample requests. */
export async function seedLeaveRequests(idOf: (key: string) => string, today: LocalDate, withPast: boolean) {
  const people = (await db().employees.find({ leavePolicyId: { $ne: null }, status: { $ne: 'inactive' } }).toArray()).map((doc) => fromDoc<Account>(doc));
  for (const person of people) await openAccount(person.id);

  const who = (key: string) => people.find((p) => p.id === idOf(key))!;
  const typeId = async (code: string) => (await db().leaveTypes.findOne({ code }))!._id;

  /** Sends a request on the first of some start dates that the rules accept. Returns it, or null when none did. */
  const ask = async (key: string, code: string, starts: readonly LocalDate[], length: number, reason: string) => {
    const leaveTypeId = await typeId(code);
    for (const startDate of starts) {
      try {
        return await submitLeave(actingAs(who(key)), { leaveTypeId, startDate, endDate: addDays(startDate, length - 1), dayPart: 'full', reason });
      } catch {
        // That date is a day off or breaks a rule for them: try the next.
      }
    }
    return null;
  };
  const from = (first: number, last: number) => Array.from({ length: Math.abs(last - first) + 1 }, (_, i) => addDays(today, first + (last >= first ? i : -i)));

  // A request still waiting for its approver, and one approved for the weeks ahead.
  await ask('divya', 'CL', from(3, 9), 2, 'A family function out of town.');
  const planned = await ask('imran', 'EL', from(10, 16), 3, 'A short trip home.');
  if (planned) await approveLeave(actingAs(who('lead')), planned.id, 'Enjoy the trip.');

  // With a past: a day of sick leave last week, asked for afterwards and approved.
  if (withPast) {
    const sick = await ask('employee', 'SL', from(-2, -6), 1, 'Down with a fever.');
    if (sick) {
      await approveLeave(actingAs(who('manager')), sick.id, '');
      // They were not at work that day: the sample attendance for it goes.
      await db().attendanceDays.deleteOne({ _id: attendanceId(sick.employeeId, sick.startDate) });
    }
  }
}
