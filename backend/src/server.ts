import { createApp } from './app';
import { config } from './config';
import { connect, db, disconnect } from './db';
import { rebuildAdmins } from './services/admins';
import { settleUnfinished } from './services/corrections';
import { settleLeaveUnfinished } from './services/leave';
import { setupGate } from './services/setup';

try {
  await connect(config.mongoUri, config.dbName);
} catch (error) {
  // The address may carry a password, so it is never printed.
  console.error('[api] Could not reach MongoDB. Is it running, and is MONGODB_URI right?');
  console.error(error instanceof Error ? error.name : 'Unknown error');
  process.exit(1);
}

// The employee records are the truth about who is an Admin; the guard list follows them.
await rebuildAdmins();

// An approval that was decided but not yet applied to its day when the server last stopped is finished now.
const settled = await settleUnfinished();
if (settled > 0) console.log(`[api] Finished ${settled} approved ${settled === 1 ? 'correction' : 'corrections'} that had not been applied yet.`);

// The same for leave: a request that was being sent or decided when the server last stopped is finished now.
const leaveSettled = await settleLeaveUnfinished();
if (leaveSettled > 0) console.log(`[api] Finished ${leaveSettled} leave ${leaveSettled === 1 ? 'request' : 'requests'} that had been left half way.`);

if ((await db().employees.estimatedDocumentCount()) === 0) {
  const gate = setupGate(config);
  if (gate === 'disabled') console.log('[api] Nobody exists yet, and first-run setup is switched off: set SETUP_CODE (see backend/.env.example) and restart.');
  else console.log(`[api] Nobody exists yet. Open the web app to set up the company and its first Admin${gate === 'code' ? ' (it will ask for SETUP_CODE)' : ''}.`);
}

const server = createApp().listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} · database "${config.dbName}" · ${config.env}`);
});

// Finish in-flight requests and close the database connection before exiting.
async function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close(async () => {
    await disconnect();
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
