import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { pingDatabase } from './db';
import { authenticate } from './http/context';
import { errorHandler, notFound } from './http/errors';
import { sameOriginOnly } from './http/security';
import { announcementRoutes } from './routes/announcements';
import { attendanceRoutes } from './routes/attendance';
import { auditRoutes } from './routes/audit';
import { correctionRoutes } from './routes/corrections';
import { publicRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { departmentRoutes, employeeRoutes } from './routes/employees';
import { holidayCalendarRoutes, holidayRoutes } from './routes/holidays';
import { leavePolicyRoutes, leaveRoutes, leaveTypeRoutes } from './routes/leave';
import { reportRoutes } from './routes/reports';
import { meRoutes } from './routes/me';
import { assignmentRoutes, scheduleRoutes } from './routes/schedules';
import { settingsRoutes } from './routes/settings';

/** Where the built web app lands (`npm run build`). Served by the API in production. */
const WEB_DIST = fileURLToPath(new URL('../../frontend/dist', import.meta.url));

/**
 * Every router that needs a signed-in session, and where it is mounted. They are all added
 * below one `authenticate`, so a new route is protected without anyone remembering to protect
 * it. The tests walk this same list and expect 401 from every route in it.
 */
export const PROTECTED_ROUTERS: readonly (readonly [prefix: string, router: Router])[] = [
  ['', meRoutes],
  ['/settings', settingsRoutes],
  ['/employees', employeeRoutes],
  ['/departments', departmentRoutes],
  ['/schedules', scheduleRoutes],
  ['/schedule-assignments', assignmentRoutes],
  ['/attendance', attendanceRoutes],
  ['/regularizations', correctionRoutes],
  ['/dashboard', dashboardRoutes],
  ['/holiday-calendars', holidayCalendarRoutes],
  ['/holidays', holidayRoutes],
  ['/leave-types', leaveTypeRoutes],
  ['/leave-policies', leavePolicyRoutes],
  ['/leave', leaveRoutes],
  ['/announcements', announcementRoutes],
  ['/reports', reportRoutes],
  ['/audit', auditRoutes],
];

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // The address and protocol a proxy reports are believed only from the proxies this server
  // was told about (config.trustProxy). With none, they are the connection's own.
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // React writes inline style attributes; nothing else inline is allowed.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          // HTTPS is the deployment's job (proxy + HSTS); forcing it here breaks plain-HTTP local runs.
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  const api = Router();
  api.use(sameOriginOnly);
  // HR data must never sit in a browser or proxy cache.
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // For uptime monitors and load balancers: 200 when the API and MongoDB both answer, 503 when
  // the API is up but cannot reach its data. Says nothing private, so it needs no session.
  api.get('/health', async (_req, res) => {
    const started = Date.now();
    const database = await pingDatabase();
    res.status(database ? 200 : 503).json({ ok: database, database: database ? 'connected' : 'unreachable', ms: Date.now() - started });
  });
  api.use(publicRoutes);

  // Everything below requires a signed-in session.
  api.use(authenticate);
  for (const [prefix, router] of PROTECTED_ROUTERS) api.use(prefix || '/', router);
  api.use(() => {
    throw notFound('There is nothing at that address.');
  });
  app.use('/api', api);

  // One deployable in production: the API also serves the built web app.
  if (config.isProduction && existsSync(WEB_DIST)) {
    // Built files are named after their contents, so a name never changes meaning: cache for a year.
    app.use('/assets', express.static(`${WEB_DIST}/assets`, { index: false, immutable: true, maxAge: '1y' }));
    // A missing built file is a 404, never the app page.
    app.use('/assets', (_req, res) => {
      res.status(404).type('text/plain').send('Not found');
    });
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (req, res) => {
      // Something that looks like a file (it has an extension) is not a page of the app.
      if (/\.[a-z0-9]+$/i.test(req.path)) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
      // Always ask for the page again, so a new release is picked up on the next visit.
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: WEB_DIST });
    });
  }

  app.use(errorHandler);
  return app;
}
