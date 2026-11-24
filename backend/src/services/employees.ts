import type { Employee, SelfEmployee } from '@delta-hrms/shared';
import { db, type Account } from '../db';

/** The code of the person first-run setup creates. Its uniqueness is what lets setup succeed only once. */
export const FIRST_EMPLOYEE_CODE = 'EMP-0001';

const formatCode = (n: number) => `EMP-${String(n).padStart(4, '0')}`;

/**
 * A person as the API may return them. This is the one place credentials are taken off, and
 * every answer that carries a person goes through it.
 */
export function toPublic({ passwordHash: _passwordHash, ...employee }: Account): Employee {
  return employee;
}

/** The next employee code: EMP-0002, EMP-0003, … One counter, raised in a single write, so no two people get the same one. */
export async function nextEmployeeCode(): Promise<string> {
  const counters = db().meta as unknown as import('mongodb').Collection<{ _id: 'counters'; value: { employeeCode: number } }>;
  const doc = await counters.findOneAndUpdate({ _id: 'counters' }, { $inc: { 'value.employeeCode': 1 } }, { upsert: true, returnDocument: 'after' });
  return formatCode(doc!.value.employeeCode);
}

/** Tells the counter that codes up to `n` are taken (setup takes the first by itself). */
export async function reserveEmployeeCodes(n: number) {
  await db().meta.updateOne({ _id: 'counters' }, { $max: { 'value.employeeCode': n } }, { upsert: true });
}

/** The signed-in person's own record, with the names it points at. */
export async function toSelf(account: Account): Promise<SelfEmployee> {
  const [manager, department] = await Promise.all([
    account.managerId ? db().employees.findOne({ _id: account.managerId }, { projection: { name: 1 } }) : null,
    account.departmentId ? db().departments.findOne({ _id: account.departmentId }, { projection: { name: 1 } }) : null,
  ]);
  return { ...toPublic(account), departmentName: department?.name ?? null, managerName: manager?.name ?? null };
}
