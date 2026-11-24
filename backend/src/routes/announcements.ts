import { Router } from 'express';
import { z } from 'zod';
import { ANNOUNCEMENT_BODY_MAX, AUDIENCE_MAX } from '@delta-hrms/shared';
import { contextOf, requirePermission } from '../http/context';
import { id } from '../http/schemas';
import { createAnnouncement, deleteAnnouncement, feedFor, manageList, markRead, pinAnnouncement, readOne, updateAnnouncement } from '../services/announcements';

/*
 * Announcements. Everyone reads the ones that are showing for them; managing them needs
 * `announcements.manage`. Reading takes nothing from the request but an id: whose list it
 * is, and whether an announcement is theirs to see, comes from the session.
 *
 * Only shapes are checked here. Whether an announcement makes sense is decided by the shared
 * `validateAnnouncement`, the same code the form runs.
 */
export const announcementRoutes = Router();

const audience = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('departments'), departmentIds: z.array(z.string().max(60)).max(AUDIENCE_MAX) }),
  z.strictObject({ kind: z.literal('roles'), roles: z.array(z.string().max(20)).max(10) }),
]);
const input = z.strictObject({
  title: z.string().max(400),
  // Room for line endings that are tidied before the length is judged.
  body: z.string().max(ANNOUNCEMENT_BODY_MAX * 2),
  importance: z.enum(['normal', 'important']),
  pinned: z.boolean(),
  startsAt: z.string().max(16).nullable(),
  expiresAt: z.string().max(16).nullable(),
  audience,
});
const nothing = z.strictObject({});

/** What is showing for the signed-in person now, and how many of them they have still to read. */
announcementRoutes.get('/', async (req, res) => {
  nothing.parse(req.query);
  res.json(await feedFor(contextOf(req).employee));
});

/** Every announcement, for those who manage them. Before `/:id` so that "manage" is never read as an id. */
announcementRoutes.get('/manage', requirePermission('announcements.manage'), async (req, res) => {
  const query = z.strictObject({ page: z.coerce.number().int().min(1).max(10_000).default(1) }).parse(req.query);
  res.json(await manageList(query.page));
});

announcementRoutes.post('/', requirePermission('announcements.manage'), async (req, res) => {
  res.status(201).json(await createAnnouncement(contextOf(req), input.parse(req.body) as Parameters<typeof createAnnouncement>[1]));
});

/** One announcement, if it is showing for the signed-in person. For anyone else it does not exist. */
announcementRoutes.get('/:id', async (req, res) => {
  res.json(await readOne(contextOf(req).employee, id.parse(req.params.id)));
});

announcementRoutes.post('/:id/read', async (req, res) => {
  nothing.parse(req.body ?? {});
  await markRead(contextOf(req).employee, id.parse(req.params.id));
  res.status(204).end();
});

announcementRoutes.patch('/:id', requirePermission('announcements.manage'), async (req, res) => {
  res.json(await updateAnnouncement(contextOf(req), id.parse(req.params.id), input.parse(req.body) as Parameters<typeof updateAnnouncement>[2]));
});

announcementRoutes.post('/:id/pin', requirePermission('announcements.manage'), async (req, res) => {
  const body = z.strictObject({ pinned: z.boolean() }).parse(req.body);
  res.json(await pinAnnouncement(contextOf(req), id.parse(req.params.id), body.pinned));
});

announcementRoutes.delete('/:id', requirePermission('announcements.manage'), async (req, res) => {
  await deleteAnnouncement(contextOf(req), id.parse(req.params.id));
  res.status(204).end();
});
