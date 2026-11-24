import type { LeaveSpan, LeaveTouched, LeaveType, LocalDate } from '@delta-hrms/shared';
import { db, fromDoc, type LeaveTypeDoc } from '../db';

/*
 * What the rest of the app needs to know about leave: the kinds of leave, which policy new
 * people are put on, and the requests that touch some dates. It lives apart from the leave
 * services so that attendance, holidays and schedules can read leave without a circle.
 */

export const toLeaveType = ({ nameKey: _key, ...doc }: LeaveTypeDoc): LeaveType => fromDoc<LeaveType>(doc);

/** Every kind of leave, archived ones included, by name. */
export async function loadLeaveTypes(): Promise<LeaveType[]> {
  return (await db().leaveTypes.find().sort({ nameKey: 1 }).toArray()).map(toLeaveType);
}

/** The policy people are put on as they are added, or null. */
export async function defaultPolicyId(): Promise<string | null> {
  const doc = await db().meta.findOne({ _id: 'leave' });
  return (doc?.value as { defaultPolicyId?: string | null } | undefined)?.defaultPolicyId ?? null;
}

export async function saveDefaultPolicy(id: string | null) {
  await db().meta.updateOne({ _id: 'leave' }, { $set: { value: { defaultPolicyId: id } } }, { upsert: true });
}

/** A request counts for the calendar while it is waiting or approved. */
const LIVE = ['pending', 'approved'] as const;

/**
 * The live leave requests of some people, as the calendar needs them: approved ones are leave
 * on their dates, waiting ones are marked. With a range, only those that touch it.
 */
export async function leaveSpansOf(employeeIds: readonly string[], range?: { from: LocalDate; to: LocalDate }): Promise<Map<string, LeaveSpan[]>> {
  const spans = new Map<string, LeaveSpan[]>();
  if (employeeIds.length === 0) return spans;
  const docs = await db()
    .leaveRequests.find({ employeeId: { $in: [...employeeIds] }, status: { $in: [...LIVE] }, ...(range ? { startDate: { $lte: range.to }, endDate: { $gte: range.from } } : {}) }, { projection: { employeeId: 1, startDate: 1, endDate: 1, dayPart: 1, status: 1, leaveTypeId: 1 } })
    .toArray();
  if (docs.length === 0) return spans;
  const types = new Map((await db().leaveTypes.find({}, { projection: { name: 1, paid: 1 } }).toArray()).map((t) => [t._id, t]));
  for (const doc of docs) {
    const type = types.get(doc.leaveTypeId);
    const list = spans.get(doc.employeeId) ?? [];
    list.push({ startDate: doc.startDate, endDate: doc.endDate, dayPart: doc.dayPart, status: doc.status as LeaveSpan['status'], name: type?.name ?? 'Leave', paid: type?.paid ?? true });
    spans.set(doc.employeeId, list);
  }
  return spans;
}

/**
 * The live leave requests of some people that reach into a stretch of dates, for whoever is
 * about to change a holiday or a schedule there: the days charged were counted with things as
 * they were. \`keep\` narrows them further (to the people a change really reaches on a date).
 */
export async function leaveTouching(employeeIds: readonly string[], from: LocalDate, to: LocalDate | null, keep: (request: { employeeId: string; startDate: LocalDate; endDate: LocalDate }) => boolean = () => true): Promise<LeaveTouched[]> {
  if (employeeIds.length === 0) return [];
  const docs = (
    await db()
      .leaveRequests.find({ employeeId: { $in: [...employeeIds] }, status: { $in: [...LIVE] }, endDate: { $gte: from }, ...(to ? { startDate: { $lte: to } } : {}) })
      .sort({ startDate: 1 })
      .toArray()
  ).filter(keep);
  if (docs.length === 0) return [];
  const [types, people] = await Promise.all([
    db().leaveTypes.find({}, { projection: { name: 1 } }).toArray(),
    db()
      .employees.find({ _id: { $in: [...new Set(docs.map((d) => d.employeeId))] } }, { projection: { name: 1 } })
      .toArray(),
  ]);
  const typeName = new Map(types.map((t) => [t._id, t.name]));
  const personName = new Map(people.map((p) => [p._id, p.name]));
  return docs.map((doc) => ({ employeeName: personName.get(doc.employeeId) ?? 'Someone', typeName: typeName.get(doc.leaveTypeId) ?? 'Leave', startDate: doc.startDate, endDate: doc.endDate, dayPart: doc.dayPart, days: doc.days, status: doc.status as LeaveTouched['status'] }));
}
