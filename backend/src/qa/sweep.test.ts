/*
 * QA sweep: every route of the API, as every role and as nobody.
 *
 * It does not test what a route does. It tests who gets through its door:
 *
 * - signed out, nobody gets anywhere;
 * - a route that declares a permission lets in exactly the roles that hold it, and answers
 *   "forbidden" to the rest;
 * - a route that declares none is on the short list below, each with the reason it is open
 *   to everyone who is signed in. There the service decides whose data the caller may touch,
 *   which the attack checks (attacks.test.ts) go after.
 *
 * A route added tomorrow without a guard, and without a line here saying why, fails this
 * file. So does a line here for a route that no longer exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, ROLES, zonedToInstant, type PermissionId, type Role } from '@delta-hrms/shared';
import { as, boot, Client, mod, reachable, resetToSample, shutdown } from '../testkit';

beforeAll(async () => {
  await boot('qa_sweep');
  if (!reachable) return;
  mod.clock.setTestNow(zonedToInstant('2026-12-07', '09:00', 'Asia/Kolkata').toISOString());
  await resetToSample();
});
afterAll(shutdown);

/**
 * Routes with no permission of their own: anyone signed in may call them, because each acts
 * only on the caller, or decides in its service whose data the caller may see.
 */
const OPEN_TO_ANYONE_SIGNED_IN: Record<string, string> = {
  'GET /me': 'who the caller is',
  'PATCH /me/profile': 'the caller’s own phone number',
  'POST /me/password': 'the caller’s own password',
  'GET /employees': 'the people the caller may see: themself, their team, or everyone',
  'GET /employees/:id': 'one person, if the caller may see them',
  'GET /employees/:id/schedule': 'one person’s schedule, if the caller may see them',
  'GET /departments': 'the department names, for filters and forms',
  'GET /attendance/today': 'the caller’s own day',
  'POST /attendance/check-in': 'the caller’s own punch',
  'POST /attendance/check-out': 'the caller’s own punch',
  'POST /attendance/break/start': 'the caller’s own break',
  'POST /attendance/break/end': 'the caller’s own break',
  'GET /attendance/calendar': 'a month: the caller’s own, or someone’s they may see',
  'GET /attendance/days/:employeeId/:date': 'one day, if the caller may see the person',
  'GET /regularizations': 'the caller’s own requests; the other views are refused in the service',
  'POST /regularizations': 'a correction of the caller’s own day',
  'POST /regularizations/:id/cancel': 'the caller’s own request',
  'POST /regularizations/:id/approve': 'decided in the service: who may decide whose request',
  'POST /regularizations/:id/reject': 'decided in the service: who may decide whose request',
  'GET /dashboard/me': 'the caller’s own home page',
  'GET /holidays/mine': 'the caller’s own holidays',
  'GET /leave-types': 'the kinds of leave, for the request form',
  'GET /leave/balances': 'a leave account: the caller’s own, or someone’s they may see',
  'GET /leave/requests': 'the caller’s own requests; the other views are refused in the service',
  'POST /leave/requests/preview': 'the caller’s own request, counted',
  'POST /leave/requests': 'the caller’s own request',
  'POST /leave/requests/:id/cancel': 'the caller’s own request, or HR for approved leave: decided in the service',
  'POST /leave/requests/:id/approve': 'decided in the service: who may decide whose request',
  'POST /leave/requests/:id/reject': 'decided in the service: who may decide whose request',
  'GET /announcements': 'what is showing for the caller',
  'GET /announcements/:id': 'one announcement, if it is showing for the caller',
  'POST /announcements/:id/read': 'the caller’s own read mark',
  'GET /reports/employee/:id': 'one person’s days: the caller’s own, or someone’s they may see with the permission',
};

interface Found {
  /** "GET /employees/:id" */
  name: string;
  method: string;
  /** The address with something in place of each parameter. */
  path: string;
  /** The permission the route declares, on itself or on its whole router. */
  guard: PermissionId | null;
}

type Guarded = { permission?: PermissionId };

/** Every route the app mounts behind sign-in, with the permission it declares. */
function routes(): Found[] {
  const found: Found[] = [];
  for (const [prefix, router] of mod.app.PROTECTED_ROUTERS) {
    // A guard put on the whole router covers every route after it.
    let onRouter: PermissionId | null = null;
    for (const layer of router.stack) {
      if (!layer.route) {
        onRouter = (layer.handle as Guarded).permission ?? onRouter;
        continue;
      }
      const own = layer.route.stack.map((step) => (step.handle as Guarded).permission).find(Boolean) ?? null;
      const template = prefix + (layer.route.path === '/' && prefix ? '' : layer.route.path);
      for (const method of Object.keys((layer.route as unknown as { methods: Record<string, boolean> }).methods)) {
        found.push({
          name: `${method.toUpperCase()} ${template}`,
          method: method.toUpperCase(),
          // A date where a date goes, and an id of the right shape that nobody has everywhere else.
          path: template.replace(/:date\b/g, '2026-12-07').replace(/:\w+/g, 'emp_000000000000'),
          guard: own ?? onRouter,
        });
      }
    }
  }
  return found;
}

describe.skipIf(!reachable)('QA sweep: every route, as every role', () => {
  const clients = new Map<Role, Client>();
  beforeAll(async () => {
    if (!reachable) return;
    for (const role of ROLES) clients.set(role, await as(role));
  });

  it('finds the whole API', () => {
    const all = routes();
    // Eighty-two when this was written. Fewer would mean routes went missing from the walk.
    expect(all.length).toBeGreaterThanOrEqual(82);
    expect(new Set(all.map((route) => route.name)).size).toBe(all.length);
    // Every area of the app is in it.
    for (const prefix of ['/me', '/settings', '/employees', '/departments', '/schedules', '/schedule-assignments', '/attendance', '/regularizations', '/dashboard', '/holiday-calendars', '/holidays', '/leave-types', '/leave-policies', '/leave', '/announcements', '/reports', '/audit']) {
      expect(all.some((route) => route.path.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it('every route either declares a permission or is on the list of routes open to anyone signed in, with its reason', () => {
    const open = routes()
      .filter((route) => route.guard === null)
      .map((route) => route.name)
      .sort();
    expect(open).toEqual(Object.keys(OPEN_TO_ANYONE_SIGNED_IN).sort());
  });

  it('signed out, or with a made-up session, nobody gets anywhere', async () => {
    const forged = new Client();
    forged.cookie = 'delta_hrms_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    for (const route of routes()) {
      const body = route.method === 'GET' ? undefined : {};
      expect((await new Client().send(route.method, route.path, body)).status, `${route.name}, signed out`).toBe(401);
      expect((await forged.send(route.method, route.path, body)).status, `${route.name}, forged`).toBe(401);
    }
  });

  it('a route that declares a permission lets in exactly the roles that hold it', async () => {
    const guarded = routes().filter((route) => route.guard !== null);
    expect(guarded.length).toBeGreaterThanOrEqual(49);
    let refused = 0;
    for (const route of guarded) {
      for (const role of ROLES) {
        const { status } = await clients.get(role)!.send(route.method, route.path, route.method === 'GET' ? undefined : {});
        const label = `${route.name} as ${role} (needs ${route.guard})`;
        if (can(role, route.guard!)) {
          // Past the door. What happens next (not found, a refused form) is the route's own business.
          expect([401, 403], label).not.toContain(status);
          expect(status, label).toBeLessThan(500);
        } else {
          expect(status, label).toBe(403);
          refused += 1;
        }
      }
    }
    // The sweep really did knock on doors that stayed shut.
    expect(refused).toBeGreaterThanOrEqual(97);
  });

  it('a route open to anyone signed in answers every role, and never with a server error', async () => {
    for (const route of routes().filter((r) => r.guard === null)) {
      for (const role of ROLES) {
        const { status } = await clients.get(role)!.send(route.method, route.path, route.method === 'GET' ? undefined : {});
        const label = `${route.name} as ${role}`;
        expect([401, 403], label).not.toContain(status);
        expect(status, label).toBeLessThan(500);
      }
    }
  });

  it('a route that takes an id or a date refuses anything that is not one, and never with a server error', async () => {
    // As the Admin, who is let through every door: what is left to stop a bad value is the route itself.
    const admin = clients.get('Admin')!;
    const hostile = ['{"$ne":null}', '$where', 'emp_', `emp_${'a'.repeat(400)}`, '..%2F..%2Fsecret', 'emp_000000000000%00', '%5B%24gt%5D', '9999-99-99', '<script>', 'null', '0'];
    const taking = routes().filter((route) => route.name.includes(':'));
    expect(taking.length).toBeGreaterThanOrEqual(30);
    let asked = 0;
    for (const route of taking) {
      const template = route.name.slice(route.name.indexOf(' ') + 1);
      for (const value of hostile) {
        const path = template.replace(/:\w+/g, value.includes('%') ? value : encodeURIComponent(value));
        const { status } = await admin.send(route.method, path, route.method === 'GET' ? undefined : {});
        expect([400, 404], `${route.method} ${path}`).toContain(status);
        asked += 1;
      }
    }
    expect(asked).toBeGreaterThanOrEqual(330);
  });

  it('nothing but reading is offered on the audit log', () => {
    const audit = routes().filter((route) => route.path.startsWith('/audit'));
    expect(audit.map((route) => [route.name, route.guard])).toEqual([['GET /audit', 'audit.view']]);
  });

  it('only an Admin gets through an Admin’s doors', () => {
    const adminOnly = routes().filter((route) => route.guard !== null && ROLES.filter((role) => can(role, route.guard!)).join() === 'Admin');
    expect(adminOnly.map((route) => route.name).sort()).toEqual(['GET /audit', 'GET /settings/company', 'PATCH /settings/company']);
  });
});
