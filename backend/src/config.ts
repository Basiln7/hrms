import { existsSync } from 'node:fs';
import { z } from 'zod';

// Reads backend/.env when it exists, using Node's built-in loader. Real environment
// variables win, so production can configure the server without a file.
if (existsSync('.env')) process.loadEnvFile('.env');

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** The port the API listens on. */
    API_PORT: z.coerce.number().int().positive().optional(),
    /** What hosting platforms set. Honoured in production only: see `port` below. */
    PORT: z.coerce.number().int().positive().optional(),
    MONGODB_URI: z.string().min(1).optional(),
    MONGODB_DB: z.string().min(1).default('delta_hrms'),
    /** Comma-separated origins the browser app is served from. */
    WEB_ORIGIN: z.string().min(1).optional(),
    SESSION_DAYS: z.coerce.number().positive().default(30),
    /** How many proxies stand between the browser and this server. See `trustProxy` below. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).optional(),
    /** First-run setup asks for this. A secret, so it has no default. */
    SETUP_CODE: z.string().optional(),
  })
  .parse(process.env);

const isProduction = env.NODE_ENV === 'production';

// Production runs on what it is told, never on a development default.
const missing = (['MONGODB_URI', 'WEB_ORIGIN'] as const).filter((name) => isProduction && !env[name]);
if (missing.length > 0) throw new Error(`Set ${missing.join(' and ')} before starting in production. See backend/.env.example.`);

const setupCode = env.SETUP_CODE?.trim() || null;
if (setupCode !== null && setupCode.length < 16) throw new Error('SETUP_CODE must be at least 16 characters. See backend/.env.example.');

export const config = {
  env: env.NODE_ENV,
  isProduction,
  isTest: env.NODE_ENV === 'test',
  // In production the API serves the web app too, so the platform's PORT is its port. In
  // development PORT belongs to whatever starts the web app (Vite, a preview tool), and the
  // API taking it would put both on one port: there it listens on API_PORT or 4200.
  port: env.API_PORT ?? (isProduction ? env.PORT : undefined) ?? 4200,
  mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
  dbName: env.MONGODB_DB,
  webOrigins: (env.WEB_ORIGIN ?? 'http://localhost:5174').split(',').map((origin) => origin.trim()).filter(Boolean),
  sessionDays: env.SESSION_DAYS,
  // A proxy passes the browser's address on in a header. The server believes that header only
  // from as many proxies as it is told are in front of it; believing it from anyone would let
  // a caller name any address, and so start a fresh count of sign-in attempts with each try.
  // In development the web app's dev server is that one proxy. Anywhere else the answer is
  // none until TRUST_PROXY says otherwise.
  trustProxy: env.TRUST_PROXY ?? (env.NODE_ENV === 'development' ? 1 : 0),
  setupCode,
} as const;
