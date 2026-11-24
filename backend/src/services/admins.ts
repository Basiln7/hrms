import { db } from '../db';

/*
 * "There is always at least one Admin."
 *
 * Counting Admins and then changing one is two steps: two Admins deactivating each other at
 * the same instant would each count two, and leave none. So the ids of the Admins who are
 * not deactivated are also kept in one document, and an Admin leaves it through a single
 * conditional write that MongoDB refuses when it would empty the list. The employee record
 * is changed only after that write succeeds.
 *
 * The employee records stay the truth about who is an Admin. This list is rebuilt from them
 * on start-up, so a stop between the two writes mends itself: the Admin simply still is one.
 */

type AdminsDoc = { _id: 'admins'; value: string[] };
const admins = () => db().meta as unknown as import('mongodb').Collection<AdminsDoc>;

/** Makes the list match the employee records. Run on start-up. */
export async function rebuildAdmins(): Promise<string[]> {
  const docs = await db().employees.find({ role: 'Admin', status: { $ne: 'inactive' } }, { projection: { _id: 1 } }).toArray();
  const ids = docs.map((d) => d._id);
  await admins().updateOne({ _id: 'admins' }, { $set: { value: ids } }, { upsert: true });
  return ids;
}

/** Call after someone has become an Admin, or an Admin has been reactivated. */
export async function addAdmin(id: string) {
  await admins().updateOne({ _id: 'admins' }, { $addToSet: { value: id } }, { upsert: true });
}

export type ReleaseResult = 'released' | 'last_admin' | 'not_an_admin';

/**
 * Call before an Admin is deactivated or given another role, and go on only when it answers
 * `released`. `last_admin` means they are the only one left and must stay.
 */
export async function releaseAdmin(id: string): Promise<ReleaseResult> {
  // Matches only when the list holds this id and at least one other ("value.1" is its second entry).
  const result = await admins().updateOne({ _id: 'admins', value: id, 'value.1': { $exists: true } }, { $pull: { value: id } });
  if (result.modifiedCount === 1) return 'released';
  const doc = await admins().findOne({ _id: 'admins' });
  return doc?.value.includes(id) ? 'last_admin' : 'not_an_admin';
}

export const LAST_ADMIN_MESSAGE = 'The company needs at least one active Admin. Make someone else an Admin first.';
