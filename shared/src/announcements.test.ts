/*
 * Announcements: when one is showing, who it is for, the order of a person's list, when it
 * counts as unread, and what HR may store.
 */
import { describe, expect, it } from 'vitest';
import { announcementState, audienceInWords, byPriority, isFor, isShownTo, isUnread, validateAnnouncement, type Announcement, type AnnouncementInput, type Audience } from './announcements';
import { zonedToInstant } from './dates';

const ZONE = 'Asia/Kolkata';
const at = (date: string, time: string) => zonedToInstant(date, time, ZONE).toISOString();
const NOW = at('2026-12-07', '10:00');

const SALES = 'dep_sales';
const SUPPORT = 'dep_support';
const everyone: Audience = { kind: 'all' };

describe('when an announcement is showing', () => {
  const window = { startsAt: at('2026-12-07', '09:00'), expiresAt: at('2026-12-09', '18:00') };

  it('is scheduled until its start, live from that very moment, and over from its end on', () => {
    expect(announcementState(window, at('2026-12-07', '08:59'))).toBe('scheduled');
    expect(announcementState(window, at('2026-12-07', '09:00'))).toBe('live');
    expect(announcementState(window, at('2026-12-09', '17:59'))).toBe('live');
    expect(announcementState(window, at('2026-12-09', '18:00'))).toBe('expired');
  });

  it('stays live for good without an end', () => {
    expect(announcementState({ startsAt: window.startsAt, expiresAt: null }, at('2031-01-01', '00:00'))).toBe('live');
  });
});

describe('who an announcement is for', () => {
  const salesExec = { role: 'Employee' as const, departmentId: SALES };
  const supportLead = { role: 'Manager' as const, departmentId: SUPPORT };
  const unplaced = { role: 'HR' as const, departmentId: null };

  it('is everyone, or the people in chosen departments, or the people with chosen roles', () => {
    expect([salesExec, supportLead, unplaced].map((who) => isFor(everyone, who))).toEqual([true, true, true]);
    expect([salesExec, supportLead, unplaced].map((who) => isFor({ kind: 'departments', departmentIds: [SALES] }, who))).toEqual([true, false, false]);
    expect([salesExec, supportLead, unplaced].map((who) => isFor({ kind: 'departments', departmentIds: [SALES, SUPPORT] }, who))).toEqual([true, true, false]);
    expect([salesExec, supportLead, unplaced].map((who) => isFor({ kind: 'roles', roles: ['Manager', 'HR'] }, who))).toEqual([false, true, true]);
  });

  it('shows it only while it is live and only to its audience', () => {
    const forSales = { startsAt: at('2026-12-07', '09:00'), expiresAt: at('2026-12-08', '09:00'), audience: { kind: 'departments', departmentIds: [SALES] } as Audience };
    expect(isShownTo(forSales, salesExec, NOW)).toBe(true);
    expect(isShownTo(forSales, supportLead, NOW)).toBe(false);
    expect(isShownTo(forSales, salesExec, at('2026-12-07', '08:00'))).toBe(false);
    expect(isShownTo(forSales, salesExec, at('2026-12-08', '09:00'))).toBe(false);
  });

  it('puts an audience into words', () => {
    const names = new Map([
      [SALES, 'Sales'],
      [SUPPORT, 'Support'],
      ['dep_ops', 'Operations'],
    ]);
    expect(audienceInWords(everyone, names)).toBe('Everyone');
    expect(audienceInWords({ kind: 'departments', departmentIds: [SUPPORT] }, names)).toBe('Support');
    expect(audienceInWords({ kind: 'departments', departmentIds: [SUPPORT, SALES, 'dep_ops'] }, names)).toBe('Operations, Sales and Support');
    expect(audienceInWords({ kind: 'departments', departmentIds: [SALES, 'dep_gone'] }, names)).toBe('Sales and a department that no longer exists');
    expect(audienceInWords({ kind: 'roles', roles: ['HR', 'Manager'] }, names)).toBe('Managers and HR');
    expect(audienceInWords({ kind: 'roles', roles: ['Employee'] }, names)).toBe('Employees');
  });
});

describe('a person’s list', () => {
  const item = (id: string, more: Partial<Pick<Announcement, 'pinned' | 'importance' | 'startsAt'>> = {}) => ({ id, pinned: false, importance: 'normal' as const, startsAt: at('2026-12-01', '09:00'), ...more });

  it('puts pinned ones first, then important ones, then the most recent', () => {
    const sorted = byPriority([
      item('old'),
      item('new', { startsAt: at('2026-12-05', '09:00') }),
      item('important', { importance: 'important' }),
      item('pinned', { pinned: true }),
      item('pinned-important', { pinned: true, importance: 'important', startsAt: at('2026-11-01', '09:00') }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(['pinned-important', 'pinned', 'important', 'new', 'old']);
  });

  it('counts an announcement as unread until it is opened, and again once its text has changed', () => {
    const a = { revisedAt: at('2026-12-07', '09:00') };
    expect(isUnread(a, null)).toBe(true);
    expect(isUnread(a, undefined)).toBe(true);
    expect(isUnread(a, at('2026-12-07', '09:30'))).toBe(false);
    expect(isUnread(a, at('2026-12-07', '09:00'))).toBe(false);
    // The text was changed at noon: a reading from the morning no longer counts.
    expect(isUnread({ revisedAt: at('2026-12-07', '12:00') }, at('2026-12-07', '09:30'))).toBe(true);
  });
});

describe('what HR may store', () => {
  const input = (more: Partial<AnnouncementInput> = {}): AnnouncementInput => ({ title: 'Office closed on Friday', body: 'The office is closed for maintenance.\nWork from home.', importance: 'normal', pinned: false, startsAt: null, expiresAt: null, audience: everyone, ...more });
  const check = (more: Partial<AnnouncementInput> = {}) => validateAnnouncement(input(more), ZONE, NOW);

  it('stores a sound announcement trimmed, starting now when no start is given', () => {
    const { errors, value } = check({ title: '  Office   closed on Friday ', body: '\r\n  The office is closed.\r\nWork from home.  \n' });
    expect(errors).toEqual({});
    expect(value).toEqual({ title: 'Office closed on Friday', body: 'The office is closed.\nWork from home.', importance: 'normal', pinned: false, startsAt: NOW, expiresAt: null, audience: { kind: 'all' } });
  });

  it('reads the two times on the wall clock of the company’s zone', () => {
    const { value } = check({ startsAt: '2026-12-08T09:00', expiresAt: '2026-12-10T18:30' });
    expect(value).toMatchObject({ startsAt: at('2026-12-08', '09:00'), expiresAt: at('2026-12-10', '18:30') });
    expect(validateAnnouncement(input({ startsAt: '2026-12-08T09:00' }), 'Asia/Dubai', NOW).value?.startsAt).toBe('2026-12-08T05:00:00.000Z');
  });

  it('keeps text as it was typed: markup, quotes and a dollar sign are only characters', () => {
    const body = '<script>alert("x")</script>\n$where: 1 == 1 & <b>bold</b>';
    expect(check({ title: '<img src=x onerror=alert(1)>', body }).value).toMatchObject({ title: '<img src=x onerror=alert(1)>', body });
  });

  it('refuses a missing or oversized title or body, and an importance it does not know', () => {
    expect(check({ title: ' a ' }).errors).toEqual({ title: 'Give the announcement a title.' });
    expect(check({ title: 'x'.repeat(121) }).errors).toHaveProperty('title');
    expect(check({ body: ' \n ' }).errors).toEqual({ body: 'Write what the announcement says.' });
    expect(check({ body: 'x'.repeat(5001) }).errors).toHaveProperty('body');
    expect(check({ importance: 'urgent' as never }).errors).toHaveProperty('importance');
    expect(check({ title: '', body: '', importance: 'x' as never }).value).toBeNull();
  });

  it('refuses times that make no sense', () => {
    expect(check({ startsAt: 'tomorrow' }).errors).toHaveProperty('startsAt');
    expect(check({ expiresAt: '2026-13-01T09:00' }).errors).toHaveProperty('expiresAt');
    expect(check({ startsAt: '2026-12-08T09:00', expiresAt: '2026-12-08T09:00' }).errors.expiresAt).toBe('It has to end after it starts.');
    expect(check({ expiresAt: '2026-12-07T09:59' }).errors.expiresAt).toBe('It has to end after it starts.');
    // It started last week and its end has passed too: it would never be shown.
    expect(check({ startsAt: '2026-12-01T09:00', expiresAt: '2026-12-07T10:00' }).errors.expiresAt).toBe('That time has already passed, so it would never be shown.');
    // A start in the past with an end still to come is fine.
    expect(check({ startsAt: '2026-12-01T09:00', expiresAt: '2026-12-07T10:01' }).errors).toEqual({});
  });

  it('wants an audience with someone in it, from the lists', () => {
    expect(check({ audience: { kind: 'departments', departmentIds: [] } }).errors.audience).toBe('Choose at least one department.');
    expect(check({ audience: { kind: 'departments', departmentIds: ['not an id'] } }).errors).toHaveProperty('audience');
    expect(check({ audience: { kind: 'roles', roles: [] } }).errors.audience).toBe('Choose at least one role.');
    expect(check({ audience: { kind: 'roles', roles: ['Owner' as never] } }).errors).toHaveProperty('audience');
    expect(check({ audience: { kind: 'team' } as never }).errors.audience).toBe('Choose who it is for.');
    // Stored once each, roles in their usual order.
    expect(check({ audience: { kind: 'departments', departmentIds: [SALES, SALES, SUPPORT] } }).value?.audience).toEqual({ kind: 'departments', departmentIds: [SALES, SUPPORT] });
    expect(check({ audience: { kind: 'roles', roles: ['Admin', 'Manager', 'Admin'] } }).value?.audience).toEqual({ kind: 'roles', roles: ['Manager', 'Admin'] });
  });
});
