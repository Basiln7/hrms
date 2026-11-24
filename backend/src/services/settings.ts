import { DEFAULT_COMPANY, type CompanySettings } from '@delta-hrms/shared';
import { db } from '../db';

export async function loadCompany(): Promise<CompanySettings> {
  const doc = await db().meta.findOne({ _id: 'company' });
  return { ...DEFAULT_COMPANY, ...((doc?.value as Partial<CompanySettings> | undefined) ?? {}) };
}

export async function saveCompany(company: CompanySettings) {
  await db().meta.updateOne({ _id: 'company' }, { $set: { value: company } }, { upsert: true });
}
