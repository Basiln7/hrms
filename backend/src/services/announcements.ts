import {
  announcementState,
  audienceInWords,
  byPriority,
  isFor,
  isShownTo,
  isUnread,
  toLocalDateTime,
  validateAnnouncement,
  type Announcement,
  type AnnouncementFeedPayload,
  type AnnouncementInput,
  type AnnouncementManagePayload,
  type AnnouncementRow,
  type AnnouncementView,
  type Audience,
  type AudienceMember,
} from '@delta-hrms/shared';
import { clock } from '../clock';
import { db, fromDoc, toDoc, type Account, type Doc } from '../db';
import type { RequestContext } from '../http/context';
import { notFound, unprocessable } from '../http/errors';
import { newId } from '../ids';
import { recordAudit } from './audit';
import { loadCompany } from './settings';

/*
 * Announcements.
 *
 * Two questions are asked on every read, and only here: is it showing at this moment on the
 * server's clock, and is this person in its audience as their record stands now. Both are
 * the shared functions. They are asked for a list and for a single announcement by id alike,
 * so knowing an id gets nobody an announcement that is not theirs or not showing.
 *
 * A title and a body are stored and returned as the text they are. Nothing in the API reads
 * them as anything else.
 */

export const ANNOUNCEMENTS_PAGE = 20;
/** More announcements than this showing at once is not a list anyone reads. The newest and the pinned come first. */
const FEED_LIMIT = 100;

const toAnnouncement = (doc: Doc<Announcement>) => fromDoc<Announcement>(doc);
const memberOf = (employee: Pick<Account, 'role' | 'departmentId'>): AudienceMember => ({ role: employee.role, departmentId: employee.departmentId });
const readId = (announcementId: string, employeeId: string) => `${announcementId}|${employeeId}`;

/** Everything showing at a moment, whoever it is for. */
async function showingAt(now: Date): Promise<Announcement[]> {
  const at = now.toISOString();
  const docs = await db()
    .announcements.find({ startsAt: { $lte: at }, $or: [{ expiresAt: null }, { expiresAt: { $gt: at } }] })
    .toArray();
  return docs.map(toAnnouncement);
}

/** When this person opened each of some announcements. */
async function readsOf(employeeId: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const docs = await db()
    .announcementReads.find({ _id: { $in: ids.map((id) => readId(id, employeeId)) } })
    .toArray();
  return new Map(docs.map((doc) => [doc.announcementId, doc.readAt]));
}

const toView = (a: Announcement, readAt: string | undefined): AnnouncementView => ({ id: a.id, title: a.title, body: a.body, importance: a.importance, pinned: a.pinned, startsAt: a.startsAt, expiresAt: a.expiresAt, postedByName: a.createdByName, unread: isUnread(a, readAt) });

/** What is showing for one person now: pinned and important first, each with whether they have still to read it. */
export async function feedFor(employee: Account): Promise<AnnouncementFeedPayload> {
  const now = clock.now();
  const mine = byPriority((await showingAt(now)).filter((a) => isFor(a.audience, memberOf(employee)))).slice(0, FEED_LIMIT);
  const reads = await readsOf(
    employee.id,
    mine.map((a) => a.id),
  );
  const items = mine.map((a) => toView(a, reads.get(a.id)));
  return { items, unread: items.filter((item) => item.unread).length };
}

/** How many announcements this person has still to read. */
export const unreadFor = async (employee: Account): Promise<number> => (await feedFor(employee)).unread;

/** The announcement, if it is showing for this person now. Otherwise it does not exist for them. */
async function shownTo(employee: Account, id: string): Promise<Announcement> {
  const doc = await db().announcements.findOne({ _id: id });
  if (!doc || !isShownTo(doc, memberOf(employee), clock.now())) throw notFound('That announcement is not there, or is no longer showing.');
  return toAnnouncement(doc);
}

export async function readOne(employee: Account, id: string): Promise<AnnouncementView> {
  const a = await shownTo(employee, id);
  return toView(a, (await readsOf(employee.id, [id])).get(id));
}

/** Records that this person has opened an announcement. Doing it again only moves the time. */
export async function markRead(employee: Account, id: string) {
  await shownTo(employee, id);
  await db().announcementReads.updateOne({ _id: readId(id, employee.id) }, { $set: { announcementId: id, employeeId: employee.id, readAt: clock.nowIso() } }, { upsert: true });
}

/** Everyone who is not deactivated, as an audience sees them. */
async function everyone(): Promise<(AudienceMember & { id: string })[]> {
  const docs = await db().employees.find({ status: { $ne: 'inactive' } }, { projection: { role: 1, departmentId: 1 } }).toArray();
  return docs.map((doc) => ({ id: doc._id, role: doc.role, departmentId: doc.departmentId }));
}

/**
 * Every announcement, for the people who manage them: newest first, each with whether it is
 * scheduled, showing or over, who it is for in words, and how many of those people have read
 * it as it now stands.
 */
export async function manageList(page: number): Promise<AnnouncementManagePayload> {
  const now = clock.now();
  const [total, docs, people, departments, company] = await Promise.all([
    db().announcements.countDocuments(),
    db()
      .announcements.find()
      .sort({ startsAt: -1, _id: -1 })
      .skip((page - 1) * ANNOUNCEMENTS_PAGE)
      .limit(ANNOUNCEMENTS_PAGE)
      .toArray(),
    everyone(),
    db().departments.find({}, { projection: { name: 1 } }).toArray(),
    loadCompany(),
  ]);
  const names = new Map(departments.map((d) => [d._id, d.name]));
  const reads = docs.length === 0 ? [] : await db().announcementReads.find({ announcementId: { $in: docs.map((d) => d._id) } }).toArray();

  const items: AnnouncementRow[] = docs.map((doc) => {
    const a = toAnnouncement(doc);
    const audience = new Set(people.filter((person) => isFor(a.audience, person)).map((person) => person.id));
    const readCount = reads.filter((read) => read.announcementId === a.id && audience.has(read.employeeId) && !isUnread(a, read.readAt)).length;
    return { ...a, state: announcementState(a, now), audienceWords: audienceInWords(a.audience, names), audienceSize: audience.size, readCount, startsAtLocal: toLocalDateTime(a.startsAt, company.timeZone), expiresAtLocal: a.expiresAt ? toLocalDateTime(a.expiresAt, company.timeZone) : null };
  });
  return { items, total, page, pageSize: ANNOUNCEMENTS_PAGE, timeZone: company.timeZone };
}

/** What HR filled in, as it is to be stored, or a refusal that names each field that is wrong. */
async function sound(input: AnnouncementInput) {
  const company = await loadCompany();
  const { errors, value } = validateAnnouncement(input, company.timeZone, clock.now());
  if (!value) throw unprocessable(Object.values(errors)[0] ?? 'That announcement is not valid.', errors);
  if (value.audience.kind === 'departments') {
    const known = await db().departments.countDocuments({ _id: { $in: value.audience.departmentIds } });
    if (known !== value.audience.departmentIds.length) throw unprocessable('One of those departments no longer exists. Choose again.', { audience: 'One of those departments no longer exists. Choose again.' });
  }
  return value;
}

async function audienceWords(audience: Audience): Promise<string> {
  const departments = audience.kind === 'departments' ? await db().departments.find({ _id: { $in: audience.departmentIds } }, { projection: { name: 1 } }).toArray() : [];
  return audienceInWords(audience, new Map(departments.map((d) => [d._id, d.name])));
}

/** What the audit log keeps of an announcement: everything but who wrote it and when. */
const facts = (a: Pick<Announcement, 'title' | 'body' | 'importance' | 'pinned' | 'startsAt' | 'expiresAt' | 'audience'>) => ({ title: a.title, body: a.body, importance: a.importance, pinned: a.pinned, startsAt: a.startsAt, expiresAt: a.expiresAt, audience: a.audience });

export async function createAnnouncement(ctx: RequestContext, input: AnnouncementInput): Promise<Announcement> {
  const value = await sound(input);
  const now = clock.nowIso();
  const announcement: Announcement = { id: newId('ann'), ...value, revisedAt: now, createdBy: ctx.employee.id, createdByName: ctx.employee.name, createdAt: now, updatedAt: now };
  await db().announcements.insertOne(toDoc(announcement));
  await recordAudit(ctx, { action: 'announcement.created', targetType: 'announcement', targetId: announcement.id, summary: `Posted the announcement "${announcement.title}" for ${(await audienceWords(announcement.audience)).toLowerCase()}.`, after: facts(announcement) });
  return announcement;
}

async function requireAnnouncement(id: string): Promise<Announcement> {
  const doc = await db().announcements.findOne({ _id: id });
  if (!doc) throw notFound('That announcement no longer exists.');
  return toAnnouncement(doc);
}

/** Changes an announcement. When its title or body changes, the people who had read it see it as new again. */
export async function updateAnnouncement(ctx: RequestContext, id: string, input: AnnouncementInput): Promise<Announcement> {
  const existing = await requireAnnouncement(id);
  const value = await sound(input);
  const now = clock.nowIso();
  const revised = value.title !== existing.title || value.body !== existing.body;
  const updated: Announcement = { ...existing, ...value, revisedAt: revised ? now : existing.revisedAt, updatedAt: now };
  await db().announcements.updateOne({ _id: id }, { $set: { ...value, revisedAt: updated.revisedAt, updatedAt: now } });
  await recordAudit(ctx, { action: 'announcement.updated', targetType: 'announcement', targetId: id, summary: `Changed the announcement "${existing.title}"${revised ? '. Its text changed, so it shows as new to everyone again' : ''}.`, before: facts(existing), after: facts(updated) });
  return updated;
}

/** Pins an announcement to the top of everyone's list, or lets it go. Nobody's read mark changes. */
export async function pinAnnouncement(ctx: RequestContext, id: string, pinned: boolean): Promise<Announcement> {
  const existing = await requireAnnouncement(id);
  if (existing.pinned === pinned) return existing;
  const now = clock.nowIso();
  await db().announcements.updateOne({ _id: id }, { $set: { pinned, updatedAt: now } });
  await recordAudit(ctx, { action: pinned ? 'announcement.pinned' : 'announcement.unpinned', targetType: 'announcement', targetId: id, summary: `${pinned ? 'Pinned' : 'Unpinned'} the announcement "${existing.title}".`, before: { pinned: existing.pinned }, after: { pinned } });
  return { ...existing, pinned, updatedAt: now };
}

/** Takes an announcement down for good, with the marks of who had read it. The audit log keeps what it said. */
export async function deleteAnnouncement(ctx: RequestContext, id: string) {
  const existing = await requireAnnouncement(id);
  await db().announcements.deleteOne({ _id: id });
  await db().announcementReads.deleteMany({ announcementId: id });
  await recordAudit(ctx, { action: 'announcement.deleted', targetType: 'announcement', targetId: id, summary: `Deleted the announcement "${existing.title}".`, before: facts(existing) });
}
