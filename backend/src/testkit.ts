/*
 * What the API test files share: a real MongoDB check, a throwaway database per test file, the
 * app listening on a spare port, and a browser-like client.
 *
 * When no MongoDB is reachable the API tests cannot run. They then show as skipped, which
 * means NOT RUN, not passed.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { expect } from 'vitest';
import type { Role } from '@delta-hrms/shared';

export const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
export const SETUP_CODE = 'setup-code-for-the-tests-only';
export const WEB_ORIGIN = 'http://localhost:5174';

async function mongoIsReachable() {
  const probe = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500 });
  try {
    await probe.connect();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

export const reachable = await mongoIsReachable();
if (!reachable) console.warn('[tests] MongoDB is not reachable: the API tests were NOT RUN.');

interface Modules {
  db: typeof import('./db').db;
  seed: typeof import('./seed/demo');
  admins: typeof import('./services/admins');
  access: typeof import('./services/access');
  clock: typeof import('./clock');
  app: typeof import('./app');
  ids: typeof import('./ids');
}

/** The app's own modules, loaded by `boot` after the environment is set, so they read the test configuration. */
export let mod: Modules;

let base = '';
let server: Server | undefined;
let teardown: (() => Promise<void>) | undefined;

/** Where the app under test is listening, for the few requests that are not JSON sent by a browser-like client. */
export const baseUrl = () => base;

/** Everything any answer said, to check at the end that none of it gave away a credential. */
export const everythingAnswered: string[] = [];

/** A browser-like client: keeps the session cookie between requests. */
export class Client {
  cookie = '';

  async send<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await response.text();
    everythingAnswered.push(text);
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T, setCookie, headers: response.headers };
  }

  /** For an answer that is not JSON (a CSV file): the text exactly as it was sent, with its headers. */
  async text(path: string) {
    const response = await fetch(base + path, { headers: this.cookie ? { cookie: this.cookie } : {} });
    // Decoded by hand: `response.text()` would drop a byte-order mark, and a CSV file's is part of what is checked.
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
    everythingAnswered.push(text);
    return { status: response.status, text, headers: response.headers };
  }

  get = <T>(path: string, headers?: Record<string, string>) => this.send<T>('GET', path, undefined, headers);
  post = <T>(path: string, body?: unknown, headers?: Record<string, string>) => this.send<T>('POST', path, body, headers);
  patch = <T>(path: string, body?: unknown, headers?: Record<string, string>) => this.send<T>('PATCH', path, body, headers);
  put = <T>(path: string, body?: unknown, headers?: Record<string, string>) => this.send<T>('PUT', path, body, headers);
  delete = <T>(path: string, headers?: Record<string, string>) => this.send<T>('DELETE', path, undefined, headers);
}

/** The sample company's sign-in for each role. */
export const emailOf: Record<Role, string> = { Admin: 'admin@delta.test', HR: 'hr@delta.test', Manager: 'manager@delta.test', Employee: 'employee@delta.test' };

export async function signIn(email: string, password?: string) {
  const client = new Client();
  const { status } = await client.post('/auth/login', { email, password: password ?? mod.seed.DEMO_PASSWORD });
  expect(status, `sign in as ${email}`).toBe(204);
  return client;
}

export const as = (role: Role) => signIn(emailOf[role]);

export const idOf = async (email: string) => (await mod.db().employees.findOne({ email }))!._id;

/** Starts the app on a spare port against a throwaway database named after the test file. */
export async function boot(name: string) {
  if (!reachable) return;
  const dbName = `delta_hrms_test_${name}_${Date.now().toString(36)}`;
  Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: MONGO_URI, MONGODB_DB: dbName, SETUP_CODE, WEB_ORIGIN });
  const { config } = await import('./config');
  const database = await import('./db');
  mod = {
    db: database.db,
    seed: await import('./seed/demo'),
    admins: await import('./services/admins'),
    access: await import('./services/access'),
    clock: await import('./clock'),
    app: await import('./app'),
    ids: await import('./ids'),
  };
  // The clean-up is in place before the slow part starts. If connecting and building the indexes
  // outlasts the hook's time limit, the throwaway database is still dropped once that work settles.
  let connecting: Promise<unknown> = Promise.resolve();
  teardown = async () => {
    await connecting.catch(() => undefined);
    if (server) await new Promise((resolve) => server!.close(resolve));
    await database.dropDatabase(config.dbName).catch(() => undefined);
    await database.disconnect();
  };
  connecting = database.connect(config.mongoUri, config.dbName);
  await connecting;
  server = mod.app.createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

export async function shutdown() {
  mod?.clock.setTestNow(null);
  await teardown?.();
}

/** Empties every collection and fills the database with the sample company again. */
export async function resetToSample() {
  const collections = mod.db();
  await Promise.all(Object.values(collections).map((collection) => (collection as { deleteMany: (filter: object) => Promise<unknown> }).deleteMany({})));
  expect(await mod.seed.seedDemo()).toBe(true);
}
