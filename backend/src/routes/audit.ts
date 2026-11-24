import { Router } from 'express';
import { z } from 'zod';
import { AUDIT_AREAS, type AuditArea } from '@delta-hrms/shared';
import { requirePermission } from '../http/context';
import { id, localDate } from '../http/schemas';
import { listAudit } from '../services/audit';

/*
 * The audit log, for those who may read it (Admin). It can only be read: there is no route
 * here, or anywhere, that changes a row or removes one.
 */
export const auditRoutes = Router();
auditRoutes.use(requirePermission('audit.view'));

auditRoutes.get('/', async (req, res) => {
  const asked = z
    .strictObject({
      area: z.enum(AUDIT_AREAS as unknown as [AuditArea, ...AuditArea[]]).optional(),
      actorId: id.optional(),
      employeeId: id.optional(),
      from: localDate.optional(),
      to: localDate.optional(),
      search: z.string().trim().max(80).optional(),
      page: z.coerce.number().int().min(1).max(10_000).default(1),
    })
    .parse(req.query);
  res.json(await listAudit(asked));
});
