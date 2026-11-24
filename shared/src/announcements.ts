/*
 * Announcements (plan.md, section 9).
 *
 * HR writes an announcement for everyone, for some departments or for some roles, from a
 * moment and optionally until one. A person is shown the announcements that are live for
 * them now, pinned and important ones first, each marked until they have opened it.
 *
 * Whether an announcement is live is a matter of the server's clock, and whether it is for
 * someone is a matter of their record as it is now. Both are decided here, by plain
 * functions; the API asks them on every request, also for a single announcement by id.
 *
 * A title and a body are text and nothing else. Nothing here, and nothing that shows them,
 * ever treats them as markup.
 */
import { fromLocalDateTime, isLocalDateTime, type Instant, type LocalDateTime } from './dates';
import { isId } from './ids';
import { isRole, ROLES, type Role } from './roles';

export const IMPORTANCE = ['normal', 'important'] as const;
export type Importance = (typeof IMPORTANCE)[number];

/** Who an announcement is for. */
export type Audience = { kind: 'all' } | { kind: 'departments'; departmentIds: string[] } | { kind: 'roles'; roles: Role[] };

export interface Announcement {
  id: string;
  title: string;
  /** Plain text. Line breaks are kept; nothing in it is ever run or read as markup. */
  body: string;
  importance: Importance;
  /** Kept at the top of everyone's list while it is live. */
  pinned: boolean;
  /** The moment it starts being shown. */
  startsAt: string;
  /** The moment it stops being shown, or null when it stays. */
  expiresAt: string | null;
  audience: Audience;
  /** When its title or body last changed. Someone who read it before that sees it as new again. */
  revisedAt: string;
  createdBy: string;
  /** A snapshot, so the record still reads after a rename. */
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/** What HR fills in. The two times are on the wall clock of the company's time zone. */
export interface AnnouncementInput {
  title: string;
  body: string;
  importance: Importance;
  pinned: boolean;
  /** Null: from now. */
  startsAt: LocalDateTime | null;
  /** Null: until it is taken down. */
  expiresAt: LocalDateTime | null;
  audience: Audience;
}

export const ANNOUNCEMENT_TITLE_MIN = 3;
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 5000;
export const AUDIENCE_MAX = 100;

const ms = (instant: Instant) => (instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant));

export type AnnouncementState = 'scheduled' | 'live' | 'expired';

export const ANNOUNCEMENT_STATE: Record<AnnouncementState, { label: string; tone: string }> = {
  scheduled: { label: 'Scheduled', tone: 'var(--blue)' },
  live: { label: 'Showing now', tone: 'var(--green)' },
  expired: { label: 'Ended', tone: 'var(--text-3)' },
};

/** Whether an announcement is yet to start, showing, or over, at a moment on the server's clock. */
export function announcementState(a: Pick<Announcement, 'startsAt' | 'expiresAt'>, now: Instant): AnnouncementState {
  const at = ms(now);
  if (at < ms(a.startsAt)) return 'scheduled';
  return a.expiresAt !== null && at >= ms(a.expiresAt) ? 'expired' : 'live';
}

/** What decides whether an announcement is for someone: their role and their department, as they are now. */
export interface AudienceMember {
  role: Role;
  departmentId: string | null;
}

/** Whether someone is in an announcement's audience. */
export function isFor(audience: Audience, who: AudienceMember): boolean {
  if (audience.kind === 'all') return true;
  if (audience.kind === 'roles') return audience.roles.includes(who.role);
  return who.departmentId !== null && audience.departmentIds.includes(who.departmentId);
}

/** Whether someone is shown an announcement at a moment: it is live, and it is for them. */
export const isShownTo = (a: Pick<Announcement, 'startsAt' | 'expiresAt' | 'audience'>, who: AudienceMember, now: Instant): boolean => announcementState(a, now) === 'live' && isFor(a.audience, who);

/** The order of a person's list: pinned first, then important, then the most recent. */
export function byPriority<T extends Pick<Announcement, 'pinned' | 'importance' | 'startsAt'>>(items: readonly T[]): T[] {
  const rank = (a: T) => (a.pinned ? 0 : 2) + (a.importance === 'important' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || ms(b.startsAt) - ms(a.startsAt));
}

/** Whether someone has still to read an announcement: never opened, or opened before its text last changed. */
export const isUnread = (a: Pick<Announcement, 'revisedAt'>, readAt: string | null | undefined): boolean => !readAt || ms(readAt) < ms(a.revisedAt);

const ROLE_PLURAL: Record<Role, string> = { Employee: 'Employees', Manager: 'Managers', HR: 'HR', Admin: 'Admins' };

const listed = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** An audience in words: "Everyone", "Sales and Support", "Managers and HR". */
export function audienceInWords(audience: Audience, departmentNames: ReadonlyMap<string, string>): string {
  if (audience.kind === 'all') return 'Everyone';
  if (audience.kind === 'roles') return listed(ROLES.filter((role) => audience.roles.includes(role)).map((role) => ROLE_PLURAL[role]));
  const names = audience.departmentIds.map((id) => departmentNames.get(id)).filter((name): name is string => Boolean(name));
  const gone = audience.departmentIds.length - names.length;
  return listed([...names.sort((a, b) => a.localeCompare(b)), ...(gone > 0 ? [gone === 1 ? 'a department that no longer exists' : `${gone} departments that no longer exist`] : [])]);
}

/** An audience with nothing in it twice, in a fixed order. */
function tidyAudience(audience: Audience): Audience {
  if (audience.kind === 'departments') return { kind: 'departments', departmentIds: [...new Set(audience.departmentIds)] };
  if (audience.kind === 'roles') return { kind: 'roles', roles: ROLES.filter((role) => audience.roles.includes(role)) };
  return { kind: 'all' };
}

/** An announcement's input as it is stored: trimmed, with its two times as moments. */
export interface SoundAnnouncement {
  title: string;
  body: string;
  importance: Importance;
  pinned: boolean;
  startsAt: string;
  expiresAt: string | null;
  audience: Audience;
}

/**
 * Checks what HR filled in. Returns what is wrong, field by field, and, when nothing is, the
 * announcement as it is to be stored. The same check runs in the form and in the API.
 *
 * @param timeZone the company's zone: the two times are on its wall clock
 * @param now      the server's time: "from now" starts then, and an end that has passed is refused
 */
export function validateAnnouncement(input: AnnouncementInput, timeZone: string, now: Instant): { errors: Record<string, string>; value: SoundAnnouncement | null } {
  const errors: Record<string, string> = {};
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title.length < ANNOUNCEMENT_TITLE_MIN) errors.title = 'Give the announcement a title.';
  else if (title.length > ANNOUNCEMENT_TITLE_MAX) errors.title = `Keep the title to ${ANNOUNCEMENT_TITLE_MAX} characters or fewer.`;
  // Line breaks inside the text are kept; only what surrounds it is trimmed.
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (body.length === 0) errors.body = 'Write what the announcement says.';
  else if (body.length > ANNOUNCEMENT_BODY_MAX) errors.body = `Keep this to ${ANNOUNCEMENT_BODY_MAX} characters or fewer.`;
  if (!IMPORTANCE.includes(input.importance)) errors.importance = 'Choose how important it is.';
  if (typeof input.pinned !== 'boolean') errors.pinned = 'Say whether it is pinned.';

  const at = ms(now);
  let startsAt: number | null = at;
  if (input.startsAt !== null) {
    if (isLocalDateTime(input.startsAt)) startsAt = fromLocalDateTime(input.startsAt, timeZone).getTime();
    else {
      startsAt = null;
      errors.startsAt = 'Give the date and time it starts, or leave it empty to start now.';
    }
  }
  let expiresAt: number | null = null;
  if (input.expiresAt !== null) {
    if (!isLocalDateTime(input.expiresAt)) errors.expiresAt = 'Give the date and time it ends, or leave it empty.';
    else {
      expiresAt = fromLocalDateTime(input.expiresAt, timeZone).getTime();
      if (startsAt !== null && expiresAt <= startsAt) errors.expiresAt = 'It has to end after it starts.';
      else if (expiresAt <= at) errors.expiresAt = 'That time has already passed, so it would never be shown.';
    }
  }

  const audience = input.audience;
  if (audience?.kind === 'departments') {
    if (!Array.isArray(audience.departmentIds) || audience.departmentIds.length === 0) errors.audience = 'Choose at least one department.';
    else if (audience.departmentIds.length > AUDIENCE_MAX || !audience.departmentIds.every(isId)) errors.audience = 'Choose departments from the list.';
  } else if (audience?.kind === 'roles') {
    if (!Array.isArray(audience.roles) || audience.roles.length === 0) errors.audience = 'Choose at least one role.';
    else if (!audience.roles.every(isRole)) errors.audience = 'Choose roles from the list.';
  } else if (audience?.kind !== 'all') errors.audience = 'Choose who it is for.';

  if (Object.keys(errors).length > 0 || startsAt === null) return { errors, value: null };
  return {
    errors,
    value: { title, body, importance: input.importance, pinned: input.pinned, startsAt: new Date(startsAt).toISOString(), expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), audience: tidyAudience(audience) },
  };
}
