/*
 * End-to-end tests of announcements (Phase 8) against a real MongoDB. The clock is set by the
 * tests and only moves forward through the file: a Monday of posting and reading, then two
 * days in which one announcement starts and ends.
 *
 * What a sound announcement is, and the order of a list, are tested in shared. Here it is
 * what the API must hold for every caller: only those who manage announcements change them;
 * an announcement reaches a person only while it is showing on the server's clock and only
 * if it is for them, by list and by id alike; a read mark is the reader's own; and text
 * comes back exactly as the text it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, zonedToInstant, type Announcement, type AnnouncementFeedPayload, type AnnouncementInput, type AnnouncementManagePayload, type AnnouncementView, type ErrorPayload, type MePayload, type MyDashboardPayload } from '@delta-hrms/shared';
import { boot, Client, idOf, mod, reachable, resetToSample, shutdown, signIn } from './testkit';

const ZONE = 'Asia/Kolkata';
const MON = '2026-12-07';
const [TUE, WED] = [addDays(MON, 1), addDays(MON, 2)];

const moment = (date: string, time: string) => zonedToInstant(date, time, ZONE).toISOString();
const setNow = (date: string, time: string) => mod.clock.setTestNow(moment(date, time));

beforeAll(async () => {
  await boot('announcements');
  if (!reachable) return;
  setNow(MON, '05:00');
  await resetToSample();
});
afterAll(shutdown);

const emailByKey = (key: string) => mod.seed.DEMO_PEOPLE.find((p) => p.key === key)!.email;
const idByKey = (key: string) => idOf(emailByKey(key));
const clients = new Map<string, Client>();
async function person(key: string) {
  let client = clients.get(key);
  if (!client) {
    client = await signIn(emailByKey(key));
    clients.set(key, client);
  }
  return client;
}
const departmentId = async (name: string) => (await mod.db().departments.findOne({ name }))!._id;

/** The announcements the tests post, by a short name. */
const made = new Map<string, Announcement>();
const idOfMade = (name: string) => made.get(name)!.id;
const nameOf = (id: string) => [...made].find(([, a]) => a.id === id)?.[0] ?? id;

const input = (more: Partial<AnnouncementInput> = {}): AnnouncementInput => ({ title: 'Office closed on Friday', body: 'The office is closed for maintenance.', importance: 'normal', pinned: false, startsAt: null, expiresAt: null, audience: { kind: 'all' }, ...more });
const post = async (key: string, more: Partial<AnnouncementInput> = {}) => (await person(key)).post<Announcement & ErrorPayload>('/announcements', input(more));
/** Posts an announcement as HR that must be accepted, and remembers it by name. */
async function posted(name: string, more: Partial<AnnouncementInput> = {}) {
  const answer = await post('hr', { title: `${name}: an announcement`, ...more });
  expect(answer.status, `${name}: ${answer.body?.error ?? ''}`).toBe(201);
  made.set(name, answer.body);
  return answer.body;
}
const feedOf = async (key: string) => (await (await person(key)).get<AnnouncementFeedPayload>('/announcements')).body;
/** The names of what someone is shown, in the order they are shown it. */
const shownTo = async (key: string) => (await feedOf(key)).items.map((item) => nameOf(item.id));
const one = async (key: string, name: string) => (await person(key)).get<AnnouncementView & ErrorPayload>(`/announcements/${idOfMade(name)}`);
const read = async (key: string, name: string) => (await person(key)).post<ErrorPayload>(`/announcements/${idOfMade(name)}/read`);
const unreadOf = async (key: string) => (await (await person(key)).get<MePayload>('/me')).body.unreadAnnouncements;
const managed = async () => (await (await person('hr')).get<AnnouncementManagePayload>('/announcements/manage')).body;
const rowOf = async (name: string) => (await managed()).items.find((row) => row.id === idOfMade(name))!;
const auditOf = (action: string) => mod.db().audit.find({ action }).sort({ $natural: 1 }).toArray();

describe.skipIf(!reachable)('announcements', () => {
  describe('posting', () => {
    it('lets only HR and Admin manage announcements; everyone may read their own list', async () => {
      setNow(MON, '08:00');
      for (const key of ['employee', 'manager']) {
        const client = await person(key);
        expect((await client.post('/announcements', input())).status, key).toBe(403);
        expect((await client.get('/announcements/manage')).status, key).toBe(403);
        expect((await client.patch('/announcements/ann_000000000000', input())).status, key).toBe(403);
        expect((await client.post('/announcements/ann_000000000000/pin', { pinned: true })).status, key).toBe(403);
        expect((await client.delete('/announcements/ann_000000000000')).status, key).toBe(403);
        expect((await client.get<AnnouncementFeedPayload>('/announcements')).body, key).toEqual({ items: [], unread: 0 });
      }
      expect((await (await person('admin')).get<AnnouncementManagePayload>('/announcements/manage')).body).toMatchObject({ items: [], total: 0, page: 1, timeZone: ZONE });
    });

    it('posts an announcement from now, for everyone, under the name of who posted it', async () => {
      const first = await posted('first');
      expect(first).toMatchObject({ title: 'first: an announcement', importance: 'normal', pinned: false, startsAt: moment(MON, '08:00'), expiresAt: null, audience: { kind: 'all' }, revisedAt: moment(MON, '08:00'), createdByName: 'Rahul Nair' });
      expect((await auditOf('announcement.created')).at(-1)).toMatchObject({ actor: { name: 'Rahul Nair' }, targetId: first.id, summary: 'Posted the announcement "first: an announcement" for everyone.', after: { title: 'first: an announcement', audience: { kind: 'all' } } });
    });

    it('says what is wrong with an announcement, by field, and accepts nothing but its own fields', async () => {
      expect((await post('hr', { title: ' ' })).body.fields).toEqual({ title: 'Give the announcement a title.' });
      expect((await post('hr', { body: '\n \n' })).body.fields).toEqual({ body: 'Write what the announcement says.' });
      expect((await post('hr', { startsAt: '2026-12-08T09:00', expiresAt: '2026-12-08T08:00' })).body.fields).toEqual({ expiresAt: 'It has to end after it starts.' });
      expect((await post('hr', { startsAt: '2026-12-01T09:00', expiresAt: '2026-12-07T07:00' })).body.fields).toEqual({ expiresAt: 'That time has already passed, so it would never be shown.' });
      expect((await post('hr', { startsAt: 'tomorrow' })).body.fields).toHaveProperty('startsAt');
      expect((await post('hr', { audience: { kind: 'departments', departmentIds: [] } })).body.fields).toEqual({ audience: 'Choose at least one department.' });
      expect((await post('hr', { audience: { kind: 'departments', departmentIds: ['dep_000000000000'] } })).body.fields).toEqual({ audience: 'One of those departments no longer exists. Choose again.' });
      expect((await post('hr', { audience: { kind: 'roles', roles: ['Owner' as never] } })).body.fields).toHaveProperty('audience');
      const hr = await person('hr');
      expect((await hr.post('/announcements', { ...input(), importance: 'urgent' })).status).toBe(400);
      expect((await hr.post('/announcements', { ...input(), createdByName: 'The CEO' })).status).toBe(400);
      expect((await hr.post('/announcements', { ...input(), audience: { kind: 'all', departmentIds: ['x'] } })).status).toBe(400);
      expect(await mod.db().announcements.countDocuments()).toBe(1);
    });

    it('text is shown as text: markup, quotes and operators come back as the characters they are', async () => {
      setNow(MON, '08:05');
      const title = '<b>Fire drill</b> & "quotes" <img src=x onerror=alert(1)>';
      const body = 'Line one.\n<script>alert("x")</script>\n$where: sleep(1000) & {{7*7}} </p>';
      const stored = await posted('text', { title: `  ${title} `, body: `\r\n${body}\r\n` });
      expect([stored.title, stored.body]).toEqual([title, body]);
      const client = await person('employee');
      const feed = await client.get<AnnouncementFeedPayload>('/announcements');
      const shown = feed.body.items.find((item) => item.id === stored.id)!;
      expect([shown.title, shown.body]).toEqual([title, body]);
      // It travels as JSON, which a browser never reads as a page, and nothing else.
      expect(feed.headers.get('content-type')).toMatch(/^application\/json/);
      expect(feed.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await mod.db().announcements.findOne({ _id: stored.id }))!.body).toBe(body);
    });

    it('posts for chosen departments, for chosen roles, pinned, important, and for later', async () => {
      setNow(MON, '09:00');
      const sales = await posted('sales', { audience: { kind: 'departments', departmentIds: [await departmentId('Sales')] } });
      expect((await auditOf('announcement.created')).at(-1)?.summary).toBe(`Posted the announcement "${sales.title}" for sales.`);
      setNow(MON, '09:01');
      await posted('managers', { audience: { kind: 'roles', roles: ['HR', 'Manager'] } });
      setNow(MON, '09:02');
      // Pinned, with a start half an hour ago: older than the rest, and still on top.
      expect((await posted('pinned', { pinned: true, startsAt: '2026-12-07T08:30' })).startsAt).toBe(moment(MON, '08:30'));
      setNow(MON, '09:03');
      await posted('important', { importance: 'important' });
      setNow(MON, '09:04');
      const later = await posted('later', { startsAt: '2026-12-08T09:00', expiresAt: '2026-12-09T18:00' });
      expect([later.startsAt, later.expiresAt]).toEqual([moment(TUE, '09:00'), moment(WED, '18:00')]);
    });
  });

  describe('reading', () => {
    it('audience (everyone, departments, roles) decides who is shown it, pinned first, then important, then the newest', async () => {
      setNow(MON, '10:00');
      // Arjun: an Employee in Sales.
      expect(await shownTo('employee')).toEqual(['pinned', 'important', 'sales', 'text', 'first']);
      // Fatima: a Manager in Sales.
      expect(await shownTo('manager')).toEqual(['pinned', 'important', 'managers', 'sales', 'text', 'first']);
      // Rahul: HR, in Operations. He posted the one for Sales and is not shown it.
      expect(await shownTo('hr')).toEqual(['pinned', 'important', 'managers', 'text', 'first']);
      // Anita: an Admin in Operations.
      expect(await shownTo('admin')).toEqual(['pinned', 'important', 'text', 'first']);
      // Nisha: a Manager in Support. Kiran: an Employee in Support.
      expect(await shownTo('nisha')).toEqual(['pinned', 'important', 'managers', 'text', 'first']);
      expect(await shownTo('kiran')).toEqual(['pinned', 'important', 'text', 'first']);

      const mine = (await feedOf('employee')).items[0]!;
      expect(mine).toEqual({ id: idOfMade('pinned'), title: 'pinned: an announcement', body: 'The office is closed for maintenance.', importance: 'normal', pinned: true, startsAt: moment(MON, '08:30'), expiresAt: null, postedByName: 'Rahul Nair', unread: true });
      // Who it was sent to is not part of what a reader is told.
      expect(mine).not.toHaveProperty('audience');
    });

    it('decides it by id as well: an announcement that is not for someone does not exist for them', async () => {
      expect((await one('employee', 'sales')).body).toMatchObject({ title: 'sales: an announcement', unread: true });
      // Not in Sales: also for HR, who may manage it but is not its audience.
      for (const key of ['hr', 'admin', 'kiran']) {
        expect((await one(key, 'sales')).status, key).toBe(404);
        expect((await read(key, 'sales')).status, key).toBe(404);
      }
      for (const key of ['employee', 'admin', 'kiran']) {
        expect((await one(key, 'managers')).status, key).toBe(404);
        expect((await read(key, 'managers')).status, key).toBe(404);
      }
      expect((await one('nisha', 'managers')).status).toBe(200);
      const client = await person('employee');
      expect((await client.get('/announcements/ann_000000000000')).status).toBe(404);
      expect((await client.get('/announcements/not-an-id')).status).toBe(400);
      // A refused read leaves no mark.
      expect(await mod.db().announcementReads.countDocuments()).toBe(0);
    });

    it('unread counts: each person’s own, down by one when one is opened, and no further when it is opened again', async () => {
      expect(await Promise.all(['employee', 'manager', 'hr', 'admin'].map(unreadOf))).toEqual([5, 6, 5, 4]);
      expect((await feedOf('employee')).unread).toBe(5);

      expect((await read('employee', 'first')).status).toBe(204);
      expect((await read('employee', 'sales')).status).toBe(204);
      expect((await read('manager', 'first')).status).toBe(204);
      expect(await Promise.all(['employee', 'manager', 'hr'].map(unreadOf))).toEqual([3, 5, 5]);
      const feed = await feedOf('employee');
      expect(feed.items.map((item) => [nameOf(item.id), item.unread])).toEqual([
        ['pinned', true],
        ['important', true],
        ['sales', false],
        ['text', true],
        ['first', false],
      ]);
      expect((await one('employee', 'first')).body.unread).toBe(false);

      setNow(MON, '10:10');
      expect((await read('employee', 'first')).status).toBe(204);
      expect(await unreadOf('employee')).toBe(3);
      expect(await mod.db().announcementReads.countDocuments({ employeeId: await idByKey('employee') })).toBe(2);
      // A read takes nothing from the request but the id.
      expect((await (await person('employee')).post(`/announcements/${idOfMade('text')}/read`, { employeeId: await idByKey('manager') })).status).toBe(400);
    });

    it('shows the first few on the home page, with how many there are and are unread', async () => {
      const home = (await (await person('employee')).get<MyDashboardPayload>('/dashboard/me')).body;
      expect(home.announcements.items.map((item) => nameOf(item.id))).toEqual(['pinned', 'important', 'sales']);
      expect(home.announcements).toMatchObject({ total: 5, unread: 3 });
    });
  });

  describe('managing', () => {
    it('lists every announcement to those who manage them, with who it is for and how many have read it', async () => {
      const list = await managed();
      expect(list).toMatchObject({ total: 7, page: 1, timeZone: ZONE });
      // Newest start first: the one for tomorrow on top.
      expect(list.items.map((row) => [nameOf(row.id), row.state, row.audienceWords, row.audienceSize, row.readCount])).toEqual([
        ['later', 'scheduled', 'Everyone', 12, 0],
        ['important', 'live', 'Everyone', 12, 0],
        ['managers', 'live', 'Managers and HR', 4, 0],
        ['sales', 'live', 'Sales', 6, 1],
        ['pinned', 'live', 'Everyone', 12, 0],
        ['text', 'live', 'Everyone', 12, 0],
        ['first', 'live', 'Everyone', 12, 2],
      ]);
      expect(list.items[0]).toMatchObject({ startsAtLocal: '2026-12-08T09:00', expiresAtLocal: '2026-12-09T18:00' });
      const hr = await person('hr');
      expect((await hr.get('/announcements/manage?page=0')).status).toBe(400);
      expect((await hr.get<AnnouncementManagePayload>('/announcements/manage?page=2')).body.items).toEqual([]);
    });

    it('shows an announcement as new again when its text changes, and not when anything else about it does', async () => {
      setNow(MON, '10:30');
      const hr = await person('hr');
      const first = made.get('first')!;
      const same = { title: first.title, body: first.body, importance: first.importance, pinned: first.pinned, startsAt: '2026-12-07T08:00', expiresAt: null, audience: first.audience };

      // Made important, nothing else: those who read it have still read it.
      const marked = await hr.patch<Announcement>(`/announcements/${first.id}`, { ...same, importance: 'important' });
      expect(marked.body).toMatchObject({ importance: 'important', revisedAt: moment(MON, '08:00'), updatedAt: moment(MON, '10:30') });
      expect(await unreadOf('employee')).toBe(3);
      expect((await rowOf('first')).readCount).toBe(2);

      // Pinned and unpinned from the list: the same.
      expect((await hr.post<Announcement>(`/announcements/${first.id}/pin`, { pinned: true })).body.pinned).toBe(true);
      expect((await shownTo('employee')).slice(0, 2)).toEqual(['first', 'pinned']);
      expect((await hr.post<Announcement>(`/announcements/${first.id}/pin`, { pinned: false })).body.pinned).toBe(false);
      expect(await unreadOf('employee')).toBe(3);
      expect((await auditOf('announcement.pinned')).length + (await auditOf('announcement.unpinned')).length).toBe(2);

      // The text is corrected: everyone who had read it is shown it as new.
      setNow(MON, '10:40');
      const revised = await hr.patch<Announcement>(`/announcements/${first.id}`, { ...same, importance: 'important', body: 'The office is closed for maintenance on Friday AND Saturday.' });
      expect(revised.body.revisedAt).toBe(moment(MON, '10:40'));
      expect(await unreadOf('employee')).toBe(4);
      expect((await one('employee', 'first')).body).toMatchObject({ unread: true, body: 'The office is closed for maintenance on Friday AND Saturday.' });
      expect((await rowOf('first')).readCount).toBe(0);
      expect((await auditOf('announcement.updated')).at(-1)).toMatchObject({ summary: 'Changed the announcement "first: an announcement". Its text changed, so it shows as new to everyone again.', before: { body: 'The office is closed for maintenance.' } });
      await read('employee', 'first');
      expect(await unreadOf('employee')).toBe(3);

      expect((await hr.patch<ErrorPayload>(`/announcements/${first.id}`, { ...same, title: '' })).body.fields).toHaveProperty('title');
      expect((await hr.patch('/announcements/ann_000000000000', same)).status).toBe(404);
      expect((await hr.post('/announcements/ann_000000000000/pin', { pinned: true })).status).toBe(404);
    });

    it('follows a person’s record as it is now: someone who leaves a department is no longer shown what is for it', async () => {
      // Divya moves from Sales to Support.
      expect(await shownTo('divya')).toContain('sales');
      await mod.db().employees.updateOne({ _id: await idByKey('divya') }, { $set: { departmentId: await departmentId('Support') } });
      expect(await shownTo('divya')).not.toContain('sales');
      expect((await one('divya', 'sales')).status).toBe(404);
      expect((await rowOf('sales')).audienceSize).toBe(5);
      // An announcement for a department can be widened afterwards.
      const sales = made.get('sales')!;
      const widened = await (await person('admin')).patch<Announcement>(`/announcements/${sales.id}`, { title: sales.title, body: sales.body, importance: 'normal', pinned: false, startsAt: '2026-12-07T09:00', expiresAt: null, audience: { kind: 'departments', departmentIds: [await departmentId('Support'), await departmentId('Sales')] } });
      expect(widened.status).toBe(200);
      expect(await shownTo('divya')).toContain('sales');
      expect(await rowOf('sales')).toMatchObject({ audienceWords: 'Sales and Support', audienceSize: 8, readCount: 1 });
    });
  });

  describe('start and expiry respected on the server’s clock', () => {
    it('shows nothing before its start, by list or by id', async () => {
      setNow(MON, '23:00');
      expect(await shownTo('employee')).not.toContain('later');
      expect((await one('employee', 'later')).status).toBe(404);
      expect((await read('employee', 'later')).status).toBe(404);
      setNow(TUE, '08:59');
      expect((await one('employee', 'later')).status).toBe(404);
      expect(await unreadOf('employee')).toBe(3);
    });

    it('shows it from the minute it starts, to everyone it is for', async () => {
      setNow(TUE, '09:00');
      expect((await one('employee', 'later')).body).toMatchObject({ title: 'later: an announcement', unread: true, startsAt: moment(TUE, '09:00'), expiresAt: moment(WED, '18:00') });
      // The newest of the ordinary ones: after the pinned and the important, before the rest.
      expect(await shownTo('employee')).toEqual(['pinned', 'important', 'first', 'later', 'sales', 'text']);
      expect(await unreadOf('employee')).toBe(4);
      expect((await rowOf('later')).state).toBe('live');
      expect((await read('employee', 'later')).status).toBe(204);
    });

    it('stops showing it at its end, also to someone who has it open', async () => {
      setNow(WED, '17:59');
      expect((await one('employee', 'later')).status).toBe(200);
      setNow(WED, '18:00');
      expect((await one('employee', 'later')).status).toBe(404);
      expect((await read('manager', 'later')).status).toBe(404);
      expect(await shownTo('employee')).not.toContain('later');
      expect(await rowOf('later')).toMatchObject({ state: 'expired', readCount: 1 });
      // It can be given more time, and is showing again.
      const later = made.get('later')!;
      const extended = await (await person('hr')).patch<Announcement>(`/announcements/${later.id}`, { title: later.title, body: later.body, importance: 'normal', pinned: false, startsAt: '2026-12-08T09:00', expiresAt: '2026-12-10T18:00', audience: { kind: 'all' } });
      expect(extended.status).toBe(200);
      expect((await one('employee', 'later')).body.unread).toBe(false);
    });
  });

  describe('taking one down', () => {
    it('deletes an announcement for good, with its read marks, and keeps what it said in the audit log', async () => {
      setNow(WED, '19:00');
      const sales = made.get('sales')!;
      expect(await mod.db().announcementReads.countDocuments({ announcementId: sales.id })).toBe(1);
      expect((await (await person('hr')).delete(`/announcements/${sales.id}`)).status).toBe(204);
      expect(await shownTo('employee')).not.toContain('sales');
      expect((await one('employee', 'sales')).status).toBe(404);
      expect((await read('employee', 'sales')).status).toBe(404);
      expect(await mod.db().announcementReads.countDocuments({ announcementId: sales.id })).toBe(0);
      expect((await managed()).total).toBe(6);
      expect((await auditOf('announcement.deleted')).at(-1)).toMatchObject({ actor: { name: 'Rahul Nair' }, targetId: sales.id, summary: 'Deleted the announcement "sales: an announcement".', before: { title: sales.title, body: sales.body } });
      expect((await (await person('hr')).delete(`/announcements/${sales.id}`)).status).toBe(404);
    });
  });
});
