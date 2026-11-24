import { Router } from 'express';
import { z } from 'zod';
import { OVERVIEW_FILTERS, type OverviewFilter } from '@delta-hrms/shared';
import { contextOf, requirePermission } from '../http/context';
import { id, localDate } from '../http/schemas';
import { myDashboard } from '../services/dashboard';
import { overview } from '../services/reports';

/** Dashboards: one answer with everything a home page needs, so it is drawn from one moment. */
export const dashboardRoutes = Router();

const nothing = z.strictObject({}, 'Your home page takes no details: it is always your own.');

/** The signed-in person's own attendance: today, this month so far, recent days. */
dashboardRoutes.get('/me', async (req, res) => {
  // No filter and no employee id: a request that tries to pass one is refused, not quietly ignored.
  nothing.parse(req.query);
  res.json(await myDashboard(contextOf(req).employee));
});

/**
 * One day for everyone the caller may see: everyone for HR and Admin, their reports for a
 * Manager. The numbers are counted over those people, and `filter` asks for the people
 * behind one of the numbers.
 */
dashboardRoutes.get('/hr', requirePermission('reports.view'), async (req, res) => {
  const asked = z
    .strictObject({
      date: localDate.optional(),
      departmentId: id.optional(),
      managerId: id.optional(),
      filter: z.enum(OVERVIEW_FILTERS as [OverviewFilter, ...OverviewFilter[]]).default('all'),
      search: z.string().trim().max(80).optional(),
      page: z.coerce.number().int().min(1).max(10_000).default(1),
    })
    .parse(req.query);
  res.json(await overview(contextOf(req), asked));
});
