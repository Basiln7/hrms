import { Router } from 'express';
import { z } from 'zod';
import { validateCompany, type CompanySettings } from '@delta-hrms/shared';
import { contextOf, requirePermission } from '../http/context';
import { unprocessable } from '../http/errors';
import { db } from '../db';
import { recordAudit } from '../services/audit';
import { loadCompany, saveCompany } from '../services/settings';

/** Company settings. Reading them here is for the settings page; everyone gets them with `/me`. */
export const settingsRoutes = Router();

settingsRoutes.get('/company', requirePermission('settings.manage'), async (_req, res) => {
  res.json(await loadCompany());
});

settingsRoutes.patch('/company', requirePermission('settings.manage'), async (req, res) => {
  const ctx = contextOf(req);
  const input = z
    .strictObject({
      name: z.string().trim().max(200),
      timeZone: z.string().max(80),
      weekStartsOn: z.enum(['monday', 'sunday']),
      leaveYearStartMonth: z.number(),
    })
    .parse(req.body);
  const problems = validateCompany(input);
  if (Object.keys(problems).length > 0) throw unprocessable(Object.values(problems)[0]!, problems);

  const before = await loadCompany();
  // Every leave account is for a leave year as it is: moving the year under them would put leave in the wrong account.
  if (input.leaveYearStartMonth !== before.leaveYearStartMonth && ((await db().leaveAccounts.estimatedDocumentCount()) > 0 || (await db().leaveRequests.estimatedDocumentCount()) > 0)) {
    const message = 'The leave year cannot be moved once leave has been granted: the accounts that exist are for the leave year as it is.';
    throw unprocessable(message, { leaveYearStartMonth: message });
  }
  const after: CompanySettings = input;
  await saveCompany(after);
  await recordAudit(ctx, { action: 'settings.company.updated', targetType: 'company', summary: 'Changed the company settings.', before, after });
  res.json(after);
});
