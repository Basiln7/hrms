import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '@delta-hrms/shared';
import { contextOf, requirePermission } from '../http/context';
import { email, id, localDate, personName, phone, required, text } from '../http/schemas';
import { assertInScope } from '../services/access';
import {
  createDepartment,
  createEmployee,
  deactivateEmployee,
  deleteDepartment,
  departmentRows,
  getEmployee,
  listEmployees,
  pickerRows,
  reactivateEmployee,
  renameDepartment,
  resetPassword,
  updateEmployee,
} from '../services/people';
import { scheduleOf } from '../services/schedules';

/** People. Reading is cut to who the caller may see; every change needs `employees.manage` and passes the shared rules. */
export const employeeRoutes = Router();

const details = {
  name: personName,
  email,
  phone,
  role: z.enum(ROLES),
  departmentId: id.nullable(),
  designation: text(80),
  managerId: id.nullable(),
  joinDate: localDate.nullable(),
};

const listQuery = z.strictObject({
  search: z.string().trim().max(80).optional(),
  departmentId: z.union([id, z.literal('none')]).optional(),
  managerId: id.optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'invited', 'inactive']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  team: z.literal('1').optional(),
});

employeeRoutes.get('/', async (req, res) => {
  const { team, ...filters } = listQuery.parse(req.query);
  res.json(await listEmployees(contextOf(req), { ...filters, search: filters.search || undefined, team: team === '1' }));
});

employeeRoutes.post('/', requirePermission('employees.manage'), async (req, res) => {
  const input = z.strictObject({ ...details, schedule: z.strictObject({ scheduleId: id, effectiveFrom: localDate }).nullable() }).parse(req.body);
  res.status(201).json(await createEmployee(contextOf(req), input));
});

/**
 * Everyone who is not deactivated, in brief, for the forms that choose people (a manager, who
 * gets a schedule). Not paged, so it is kept small and is only for people who may see everyone.
 */
employeeRoutes.get('/picker', requirePermission('employees.viewAll'), async (_req, res) => {
  res.json(await pickerRows());
});

employeeRoutes.get('/:id', async (req, res) => {
  res.json(await getEmployee(contextOf(req), id.parse(req.params.id)));
});

employeeRoutes.patch('/:id', requirePermission('employees.manage'), async (req, res) => {
  const input = z.strictObject(details).parse(req.body);
  res.json(await updateEmployee(contextOf(req), id.parse(req.params.id), input));
});

employeeRoutes.post('/:id/status', requirePermission('employees.manage'), async (req, res) => {
  const input = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('inactive'), lastWorkingDay: localDate }), z.strictObject({ status: z.literal('active'), from: localDate })]).parse(req.body);
  const ctx = contextOf(req);
  const target = id.parse(req.params.id);
  res.json(input.status === 'inactive' ? await deactivateEmployee(ctx, target, input.lastWorkingDay) : await reactivateEmployee(ctx, target, input.from));
});

employeeRoutes.post('/:id/reset-password', requirePermission('employees.manage'), async (req, res) => {
  res.json(await resetPassword(contextOf(req), id.parse(req.params.id)));
});

/** A person's schedule: today's rules, what is planned, and the history. Their own, or anyone the caller may see. */
employeeRoutes.get('/:id/schedule', async (req, res) => {
  const target = id.parse(req.params.id);
  await assertInScope(contextOf(req), target);
  res.json(await scheduleOf(target));
});

/** Departments. Everyone signed in may read the names (for filters and forms); the head counts are for people who may see everyone. */
export const departmentRoutes = Router();

const departmentName = required(60, 'Give the department a name.').min(2, 'Give the department a name.');

departmentRoutes.get('/', async (req, res) => {
  res.json(await departmentRows(contextOf(req).can('employees.viewAll')));
});

departmentRoutes.post('/', requirePermission('employees.manage'), async (req, res) => {
  const input = z.strictObject({ name: departmentName }).parse(req.body);
  res.status(201).json(await createDepartment(contextOf(req), input.name));
});

departmentRoutes.patch('/:id', requirePermission('employees.manage'), async (req, res) => {
  const input = z.strictObject({ name: departmentName }).parse(req.body);
  await renameDepartment(contextOf(req), id.parse(req.params.id), input.name);
  res.status(204).end();
});

departmentRoutes.delete('/:id', requirePermission('employees.manage'), async (req, res) => {
  await deleteDepartment(contextOf(req), id.parse(req.params.id));
  res.status(204).end();
});
