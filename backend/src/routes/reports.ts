import { Router, type Response } from 'express';
import { z } from 'zod';
import { isLocalMonth, toCsv, type CsvCell } from '@delta-hrms/shared';
import { contextOf, requirePermission } from '../http/context';
import { forbidden } from '../http/errors';
import { id, localDate } from '../http/schemas';
import { employeeCsv, employeeReport, monthlyCsv, monthlyReport, reportPeople } from '../services/reports';

/*
 * Reports. Whose data a caller gets is decided in the service on every call; these routes
 * only read the question. A report as a file (`format=csv`) needs the permission to export,
 * except one's own attendance, which is one's own to take away.
 */

export const format = z.enum(['json', 'csv']).default('json');
export const peopleFilter = { departmentId: id.optional(), managerId: id.optional() };

/** Sends rows as a CSV file to be saved, never shown: a browser must not try to display it as a page. */
export function sendCsv(res: Response, file: { filename: string; rows: CsvCell[][] }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(toCsv(file.rows));
}

export const reportRoutes = Router();

/** The people the caller's reports cover, for the forms that choose one. */
reportRoutes.get('/people', requirePermission('reports.view'), async (req, res) => {
  z.strictObject({}).parse(req.query);
  res.json(await reportPeople(contextOf(req)));
});

reportRoutes.get('/monthly', requirePermission('reports.view'), async (req, res) => {
  const ctx = contextOf(req);
  const { format: as, ...asked } = z.strictObject({ month: z.string().refine(isLocalMonth, 'That month is not valid.').optional(), ...peopleFilter, format }).parse(req.query);
  if (as === 'csv') {
    if (!ctx.can('reports.export')) throw forbidden('Your role cannot download reports.');
    sendCsv(res, await monthlyCsv(ctx, asked));
  } else res.json(await monthlyReport(ctx, asked));
});

/** One person's days: the caller's own, or someone they may see. Who that is, is decided in the service. */
reportRoutes.get('/employee/:id', async (req, res) => {
  const ctx = contextOf(req);
  const { format: as, ...asked } = z.strictObject({ from: localDate.optional(), to: localDate.optional(), format }).parse(req.query);
  const employeeId = id.parse(req.params.id);
  if (as === 'csv') sendCsv(res, await employeeCsv(ctx, employeeId, asked));
  else res.json(await employeeReport(ctx, employeeId, asked));
});
