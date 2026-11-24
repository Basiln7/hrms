/*
 * End-to-end tests of the foundation (Phase 1) against a real MongoDB: first-run setup,
 * sign-in, sessions, roles, the guards. The set-up they share with the other API test files
 * is in testkit.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, OWN_RECORD_MESSAGE, PASSWORD_CHANGE_REQUIRED, permissionsOf, type CompanySettings, type ErrorPayload, type MePayload, type MetaPayload } from '@delta-hrms/shared';
import { as, boot, Client, emailOf, everythingAnswered, idOf, mod, reachable, resetToSample, SETUP_CODE, shutdown, signIn, WEB_ORIGIN } from './testkit';

beforeAll(() => boot('foundation'));
afterAll(shutdown);

describe.skipIf(!reachable)('the API', () => {
  it('answers the health check', async () => {
    const { status, body } = await new Client().get<{ ok: boolean; database: string }>('/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, database: 'connected' });
  });

  describe('first-run setup', () => {
    const setup = (over: Record<string, unknown> = {}) => ({ companyName: 'Delta', timeZone: 'Asia/Kolkata', name: 'First Admin', email: 'first@delta.test', password: 'a-good-password', setupCode: SETUP_CODE, ...over });

    it('says setup is needed, and that it wants the code', async () => {
      const { body } = await new Client().get<MetaPayload>('/meta');
      expect(body).toEqual({ setupNeeded: true, setupCodeRequired: true, setupAvailable: true });
    });

    it('refuses setup without the code or with the wrong one, and creates nobody', async () => {
      const { setupCode: _none, ...withoutCode } = setup();
      expect((await new Client().post('/setup', withoutCode)).status).toBe(403);
      expect((await new Client().post('/setup', setup({ setupCode: 'a-wrong-setup-code-entirely' }))).status).toBe(403);
      expect(await mod.db().employees.countDocuments()).toBe(0);
    });

    it('checks what it is given before creating anyone', async () => {
      const zone = await new Client().post<ErrorPayload>('/setup', setup({ timeZone: 'India' }));
      expect(zone.status).toBe(422);
      expect(zone.body.fields).toHaveProperty('timeZone');
      const short = await new Client().post<ErrorPayload>('/setup', setup({ password: 'short' }));
      expect(short.status).toBe(400);
      expect(short.body.fields).toHaveProperty('password');
      const extra = await new Client().post('/setup', setup({ role: 'Admin' }));
      expect(extra.status).toBe(400);
      const noCompany = await new Client().post<ErrorPayload>('/setup', setup({ companyName: ' ' }));
      expect(noCompany.status).toBe(400);
      expect(await mod.db().employees.countDocuments()).toBe(0);
    });

    it('lets exactly one of two setups arriving together win', async () => {
      const first = new Client();
      const second = new Client();
      const results = await Promise.all([
        first.post('/setup', setup({ email: 'first@delta.test', companyName: 'Delta One' })),
        second.post('/setup', setup({ email: 'second@delta.test', companyName: 'Delta Two', name: 'Second Admin' })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);

      const people = await mod.db().employees.find().toArray();
      expect(people).toHaveLength(1);
      const admin = people[0]!;
      expect(admin).toMatchObject({ code: 'EMP-0001', role: 'Admin', status: 'active', mustChangePassword: false });

      // The company is the winner's, not overwritten by the one who lost.
      const winner = results[0]!.status === 204 ? first : second;
      const loser = winner === first ? second : first;
      const me = await winner.get<MePayload>('/me');
      expect(me.status).toBe(200);
      expect(me.body.employee.email).toBe(admin.email);
      expect(me.body.company.name).toBe(admin.email === 'first@delta.test' ? 'Delta One' : 'Delta Two');
      expect(me.body.company.timeZone).toBe('Asia/Kolkata');
      expect((await loser.get('/me')).status).toBe(401);

      expect((await mod.db().meta.findOne({ _id: 'admins' }))?.value).toEqual([admin._id]);
      const audit = await mod.db().audit.find({ action: 'setup.completed' }).sort({ $natural: 1 }).toArray();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor?.id).toBe(admin._id);
    });

    it('is closed for ever after', async () => {
      expect((await new Client().post('/setup', setup({ email: 'third@delta.test' }))).status).toBe(409);
      expect((await new Client().get<MetaPayload>('/meta')).body.setupNeeded).toBe(false);
      expect(await mod.db().employees.countDocuments()).toBe(1);
    });
  });

  describe('with the sample company', () => {
    beforeAll(async () => {
      // Start again from the sample company.
      await resetToSample();
    });

    describe('signing in', () => {
      it('refuses a wrong password and an unknown email in the same words', async () => {
        const wrong = await new Client().post<ErrorPayload>('/auth/login', { email: emailOf.Employee, password: 'not-the-password' });
        const unknown = await new Client().post<ErrorPayload>('/auth/login', { email: 'stranger@delta.test', password: 'not-the-password' });
        expect(wrong.status).toBe(401);
        expect(unknown.status).toBe(401);
        expect(unknown.body.error).toBe(wrong.body.error);
        expect(wrong.setCookie).toBeNull();
      });

      it('sets a cookie scripts cannot read, and keeps only its hash', async () => {
        const client = new Client();
        const { status, setCookie } = await client.post('/auth/login', { email: emailOf.Employee, password: mod.seed.DEMO_PASSWORD });
        expect(status).toBe(204);
        expect(setCookie).toMatch(/^delta_hrms_session=/);
        expect(setCookie).toMatch(/HttpOnly/i);
        expect(setCookie).toMatch(/SameSite=Lax/i);
        expect(setCookie).toMatch(/Path=\//i);
        expect(setCookie).toMatch(/Max-Age=/i);
        const token = client.cookie.split('=')[1]!;
        expect(await mod.db().sessions.findOne({ _id: token })).toBeNull();
        expect(await mod.db().sessions.countDocuments({ employeeId: await idOf(emailOf.Employee) })).toBeGreaterThan(0);
      });

      it('ends with the browser when "remember me" is off', async () => {
        const { setCookie } = await new Client().post('/auth/login', { email: emailOf.Employee, password: mod.seed.DEMO_PASSWORD, remember: false });
        expect(setCookie).not.toMatch(/Max-Age=|Expires=/i);
      });

      it('tells each person who they are and what their role may do', async () => {
        for (const role of ['Admin', 'HR', 'Manager', 'Employee'] as const) {
          const { status, body } = await (await as(role)).get<MePayload>('/me');
          expect(status).toBe(200);
          expect(body.employee).toMatchObject({ email: emailOf[role], role, status: 'active' });
          expect(body.employee).not.toHaveProperty('passwordHash');
          expect(body.permissions).toEqual(permissionsOf(role));
          expect(body.company).toMatchObject({ name: 'Delta (sample)', timeZone: 'Asia/Kolkata' });
          expect(Math.abs(Date.parse(body.serverNow) - Date.now())).toBeLessThan(5000);
        }
        const employee = (await (await as('Employee')).get<MePayload>('/me')).body.employee;
        expect(employee.managerName).toBe('Fatima Khan');
        expect(employee.code).toMatch(/^EMP-\d{4}$/);
      });

      it('gives the time from the server’s clock', async () => {
        const client = await as('Employee');
        mod.clock.setTestNow('2030-01-02T03:04:05.000Z');
        try {
          expect((await client.get<MePayload>('/me')).body.serverNow).toBe('2030-01-02T03:04:05.000Z');
        } finally {
          mod.clock.setTestNow(null);
        }
      });

      it('slows down guessing: ten tries, then a wait, even with the right password', async () => {
        const email = 'guessed@delta.test';
        for (let i = 0; i < 10; i += 1) {
          expect((await new Client().post('/auth/login', { email, password: `guess-${i}` })).status).toBe(401);
        }
        expect((await new Client().post('/auth/login', { email, password: 'guess-11' })).status).toBe(429);
        // Someone else signing in from the same place is not held up.
        await as('Employee');
      });

      it('signs out: the cookie stops working and the session is gone', async () => {
        const client = await as('Employee');
        const before = await mod.db().sessions.countDocuments();
        const cookie = client.cookie;
        expect((await client.post('/auth/logout')).status).toBe(204);
        expect(await mod.db().sessions.countDocuments()).toBe(before - 1);
        const stale = new Client();
        stale.cookie = cookie;
        expect((await stale.get('/me')).status).toBe(401);
      });

      it('shuts a deactivated person out at their next click, and at the door', async () => {
        const id = mod.ids.newId('emp');
        const source = (await mod.db().employees.findOne({ email: emailOf.Employee }))!;
        await mod.db().employees.insertOne({ ...source, _id: id, code: 'EMP-0900', email: 'leaver@delta.test', name: 'Leela Leaver' });
        const client = await signIn('leaver@delta.test');
        expect((await client.get('/me')).status).toBe(200);

        await mod.db().employees.updateOne({ _id: id }, { $set: { status: 'inactive' } });
        expect((await client.get('/me')).status).toBe(401);
        expect(await mod.db().sessions.countDocuments({ employeeId: id })).toBe(0);
        const again = await new Client().post<ErrorPayload>('/auth/login', { email: 'leaver@delta.test', password: mod.seed.DEMO_PASSWORD });
        expect(again.status).toBe(403);
        await mod.db().employees.deleteOne({ _id: id });
      });
    });

    describe('every route needs a session unless it is on the short public list', () => {
      const protectedRoutes = () => {
        const found: { method: string; path: string }[] = [];
        for (const [prefix, router] of mod.app.PROTECTED_ROUTERS) {
          for (const layer of router.stack) {
            if (!layer.route) continue;
            const methods = Object.keys((layer.route as unknown as { methods: Record<string, boolean> }).methods);
            for (const method of methods) found.push({ method: method.toUpperCase(), path: (prefix + layer.route.path).replace(/:\w+/g, 'emp_000000000000') });
          }
        }
        return found;
      };

      it('finds the routes it is meant to check', () => {
        const names = protectedRoutes().map((r) => `${r.method} ${r.path}`);
        expect(names).toEqual(expect.arrayContaining(['GET /me', 'PATCH /me/profile', 'POST /me/password', 'GET /settings/company', 'PATCH /settings/company']));
      });

      it('answers 401 to each of them without a session, and with a made-up one', async () => {
        for (const route of protectedRoutes()) {
          const body = route.method === 'GET' ? undefined : {};
          expect((await new Client().send(route.method, route.path, body)).status, `${route.method} ${route.path}`).toBe(401);
          const forged = new Client();
          forged.cookie = 'delta_hrms_session=not-a-real-session-token';
          expect((await forged.send(route.method, route.path, body)).status, `${route.method} ${route.path} (forged)`).toBe(401);
        }
      });

      it('answers 401, not 404, for an address that does not exist', async () => {
        expect((await new Client().get('/employees')).status).toBe(401);
        expect((await new Client().get('/no/such/thing')).status).toBe(401);
        expect((await (await as('Employee')).get('/no/such/thing')).status).toBe(404);
      });
    });

    describe('roles', () => {
      const good: CompanySettings = { name: 'Delta Commerce Academy', timeZone: 'Asia/Dubai', weekStartsOn: 'sunday', leaveYearStartMonth: 4 };

      it('keeps company settings for the Admin: everyone else is refused, to read and to change', async () => {
        for (const role of ['Employee', 'Manager', 'HR'] as const) {
          expect(can(role, 'settings.manage')).toBe(false);
          const client = await as(role);
          expect((await client.get('/settings/company')).status, `${role} read`).toBe(403);
          expect((await client.patch('/settings/company', good)).status, `${role} change`).toBe(403);
        }
        expect((await mod.db().meta.findOne({ _id: 'company' }))?.value).toMatchObject({ name: 'Delta (sample)' });
      });

      it('lets the Admin change them, and writes it in the audit log with before and after', async () => {
        const admin = await as('Admin');
        const { status, body } = await admin.patch<CompanySettings>('/settings/company', good);
        expect(status).toBe(200);
        expect(body).toEqual(good);
        expect((await admin.get<MePayload>('/me')).body.company).toEqual(good);
        // Everyone sees the new settings at once.
        expect((await (await as('Employee')).get<MePayload>('/me')).body.company.timeZone).toBe('Asia/Dubai');

        const rows = await mod.db().audit.find({ action: 'settings.company.updated' }).sort({ $natural: 1 }).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor: { name: 'Anita Menon', role: 'Admin' }, before: { timeZone: 'Asia/Kolkata' }, after: { timeZone: 'Asia/Dubai' } });
      });

      it('refuses settings that make no sense, naming the field', async () => {
        const admin = await as('Admin');
        const zone = await admin.patch<ErrorPayload>('/settings/company', { ...good, timeZone: 'Dubai time' });
        expect(zone.status).toBe(422);
        expect(zone.body.fields).toHaveProperty('timeZone');
        const month = await admin.patch<ErrorPayload>('/settings/company', { ...good, leaveYearStartMonth: 13 });
        expect(month.status).toBe(422);
        expect(month.body.fields).toHaveProperty('leaveYearStartMonth');
        expect((await admin.patch('/settings/company', { ...good, weekStartsOn: 'friday' })).status).toBe(400);
        expect((await admin.patch('/settings/company', { ...good, currency: 'INR' })).status).toBe(400);
        expect((await admin.get<CompanySettings>('/settings/company')).body).toEqual(good);
      });
    });

    describe('requests from other websites', () => {
      it('refuses a change that comes from another site, even with a valid session', async () => {
        const admin = await as('Admin');
        const before = (await admin.get<CompanySettings>('/settings/company')).body;
        const evil = { Origin: 'https://evil.example' };
        expect((await admin.patch('/settings/company', { ...before, name: 'Hacked' }, evil)).status).toBe(403);
        expect((await admin.post('/me/password', { current: 'x', next: 'y' }, evil)).status).toBe(403);
        expect((await new Client().post('/auth/login', { email: emailOf.Admin, password: mod.seed.DEMO_PASSWORD }, evil)).status).toBe(403);
        expect((await admin.get<CompanySettings>('/settings/company')).body).toEqual(before);
      });

      it('accepts the same change from the web app’s own address', async () => {
        const admin = await as('Admin');
        const before = (await admin.get<CompanySettings>('/settings/company')).body;
        expect((await admin.patch('/settings/company', before, { Origin: WEB_ORIGIN })).status).toBe(200);
      });

      it('tells browsers never to keep an answer', async () => {
        const { headers } = await (await as('Employee')).get('/me');
        expect(headers.get('cache-control')).toBe('no-store');
        expect(headers.get('x-powered-by')).toBeNull();
        expect(headers.get('content-security-policy')).toContain("default-src 'self'");
      });
    });

    describe('passwords and profile', () => {
      it('lets people change their own phone number and nothing else', async () => {
        const client = await as('Employee');
        expect((await client.patch('/me/profile', { phone: '+91 98470 12345' })).status).toBe(204);
        expect((await client.get<MePayload>('/me')).body.employee.phone).toBe('+91 98470 12345');
        expect((await client.patch('/me/profile', { phone: '+91 98470 12345', role: 'Admin' })).status).toBe(400);
        expect((await client.patch('/me/profile', { phone: '+91 98470 12345', name: 'Someone Else' })).status).toBe(400);
        expect((await client.patch('/me/profile', { phone: 'call me' })).status).toBe(400);
        const me = (await client.get<MePayload>('/me')).body.employee;
        expect(me).toMatchObject({ role: 'Employee', name: 'Arjun Das' });
      });

      it('changes a password only with the current one, and signs the other devices out', async () => {
        const next = 'a-brand-new-password';
        const here = await as('Manager');
        const elsewhere = await as('Manager');
        expect((await here.post('/me/password', { current: 'wrong-current-password', next })).status).toBe(403);
        expect((await here.post('/me/password', { current: mod.seed.DEMO_PASSWORD, next: 'short' })).status).toBe(400);
        expect((await here.post('/me/password', { current: mod.seed.DEMO_PASSWORD, next: mod.seed.DEMO_PASSWORD })).status).toBe(400);
        expect((await elsewhere.get('/me')).status).toBe(200);

        expect((await here.post('/me/password', { current: mod.seed.DEMO_PASSWORD, next })).status).toBe(204);
        expect((await here.get('/me')).status).toBe(200);
        expect((await elsewhere.get('/me')).status).toBe(401);
        expect((await new Client().post('/auth/login', { email: emailOf.Manager, password: mod.seed.DEMO_PASSWORD })).status).toBe(401);
        const back = await signIn(emailOf.Manager, next);
        // Put it back for the tests that follow.
        expect((await back.post('/me/password', { current: next, next: mod.seed.DEMO_PASSWORD })).status).toBe(204);
      });

      it('holds someone with a temporary password at one door until they choose their own', async () => {
        const joiner = await signIn('newjoiner@delta.test');
        // Signing in for the first time makes an invited account active.
        const me = await joiner.get<MePayload>('/me');
        expect(me.status).toBe(200);
        expect(me.body.employee).toMatchObject({ status: 'active', mustChangePassword: true });

        const blocked = await joiner.patch<ErrorPayload>('/me/profile', { phone: '123' });
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe(PASSWORD_CHANGE_REQUIRED);
        expect((await joiner.get<ErrorPayload>('/settings/company')).body.code).toBe(PASSWORD_CHANGE_REQUIRED);

        expect((await joiner.post('/me/password', { current: mod.seed.DEMO_PASSWORD, next: 'my-own-password-now' })).status).toBe(204);
        expect((await joiner.get<MePayload>('/me')).body.employee.mustChangePassword).toBe(false);
        expect((await joiner.patch('/me/profile', { phone: '123' })).status).toBe(204);
      });
    });

    describe('who may see whom, on the server', () => {
      const ctxOf = async (email: string) => {
        const doc = (await mod.db().employees.findOne({ email }))!;
        const { _id, ...rest } = doc;
        const employee = { id: _id, ...rest };
        return { employee, session: {} as never, can: (permission: Parameters<typeof can>[1]) => can(employee.role, permission), ip: '' };
      };
      const rejects = async (work: Promise<unknown>, status: number) => {
        await expect(work).rejects.toMatchObject({ status });
      };

      it('answers "not found" for someone outside the caller’s scope, exactly as for nobody at all', async () => {
        const [employee, manager, hr] = await Promise.all([ctxOf(emailOf.Employee), ctxOf(emailOf.Manager), ctxOf(emailOf.HR)]);
        await rejects(mod.access.assertInScope(employee, manager.employee.id), 404);
        await rejects(mod.access.assertInScope(employee, 'emp_doesnotexist'), 404);
        await mod.access.assertInScope(employee, employee.employee.id);

        await mod.access.assertInScope(manager, employee.employee.id);
        await mod.access.assertInScope(manager, manager.employee.id);
        await rejects(mod.access.assertInScope(manager, hr.employee.id), 404);
        await rejects(mod.access.assertInScope(manager, 'emp_doesnotexist'), 404);

        await mod.access.assertInScope(hr, employee.employee.id);
        await mod.access.assertInScope(hr, manager.employee.id);
      });

      it('stops HR and Admin using an HR power on their own record', async () => {
        const [admin, hr, employee] = await Promise.all([ctxOf(emailOf.Admin), ctxOf(emailOf.HR), ctxOf(emailOf.Employee)]);
        expect(await mod.access.guardOwnRecord(hr, [employee.employee.id])).toEqual({ selfAdministered: false });
        await expect(mod.access.guardOwnRecord(hr, [hr.employee.id])).rejects.toMatchObject({ status: 403, message: OWN_RECORD_MESSAGE });
        await rejects(mod.access.guardOwnRecord(hr, [employee.employee.id, hr.employee.id]), 403);
        // An Admin too, while another HR or Admin exists.
        await rejects(mod.access.guardOwnRecord(admin, [admin.employee.id]), 403);
      });

      it('lets an Admin who is the only HR or Admin do it, and marks it', async () => {
        const [admin, hr] = await Promise.all([ctxOf(emailOf.Admin), ctxOf(emailOf.HR)]);
        await mod.db().employees.updateOne({ _id: hr.employee.id }, { $set: { status: 'inactive' } });
        try {
          expect(await mod.access.guardOwnRecord(admin, [admin.employee.id])).toEqual({ selfAdministered: true });
        } finally {
          await mod.db().employees.updateOne({ _id: hr.employee.id }, { $set: { status: 'active' } });
        }
      });
    });

    describe('there is always an Admin', () => {
      it('will not release the only Admin', async () => {
        const adminId = await idOf(emailOf.Admin);
        expect(await mod.admins.rebuildAdmins()).toEqual([adminId]);
        expect(await mod.admins.releaseAdmin(adminId)).toBe('last_admin');
        expect(await mod.admins.releaseAdmin(await idOf(emailOf.HR))).toBe('not_an_admin');
        expect((await mod.db().meta.findOne({ _id: 'admins' }))?.value).toEqual([adminId]);
      });

      it('leaves one when two Admins are released at the same instant', async () => {
        const first = await idOf(emailOf.Admin);
        const second = mod.ids.newId('emp');
        const source = (await mod.db().employees.findOne({ _id: first }))!;
        await mod.db().employees.insertOne({ ...source, _id: second, code: 'EMP-0901', email: 'second.admin@delta.test', name: 'Second Admin' });
        try {
          for (let round = 0; round < 20; round += 1) {
            expect((await mod.admins.rebuildAdmins()).sort()).toEqual([first, second].sort());
            const results = await Promise.all([mod.admins.releaseAdmin(first), mod.admins.releaseAdmin(second)]);
            expect([...results].sort(), `round ${round}`).toEqual(['last_admin', 'released']);
            expect((await mod.db().meta.findOne({ _id: 'admins' }))?.value).toHaveLength(1);
          }
        } finally {
          await mod.db().employees.deleteOne({ _id: second });
          await mod.admins.rebuildAdmins();
        }
      });

      it('hands out employee codes one at a time, even when many are asked for at once', async () => {
        const { nextEmployeeCode } = await import('./services/employees');
        const codes = await Promise.all(Array.from({ length: 25 }, () => nextEmployeeCode()));
        expect(new Set(codes).size).toBe(25);
        // The sample company took the first ones.
        expect(codes.map((c) => Number(c.slice(4))).sort((a, b) => a - b)[0]).toBe(mod.seed.DEMO_PEOPLE.length + 1);
      });
    });

    it('never said a password digest in any answer', () => {
      expect(everythingAnswered.length).toBeGreaterThan(50);
      for (const text of everythingAnswered) {
        expect(text).not.toContain('scrypt$');
        expect(text).not.toMatch(/"passwordHash"\s*:/);
      }
    });
  });
});
