/*
 * `npm run seed`              fills an empty database with the sample company
 * `npm run seed -- --reset`   wipes this app's database first, then fills it
 * `npm run seed -- --history` also gives the sample company three weeks of sample attendance
 * `npm run seed -- --wipe`    wipes this app's database and leaves it empty, to see first-run setup again
 *
 * Development only.
 */
import { config } from '../config';
import { connect, disconnect, dropDatabase } from '../db';
import { DEMO_PEOPLE, seedDemo } from './demo';

/** How far back `--history` goes. */
const HISTORY_DAYS = 21;

if (config.isProduction) {
  console.error('[seed] The sample company cannot be created in production.');
  process.exit(1);
}

await connect(config.mongoUri, config.dbName);
try {
  const wipeOnly = process.argv.includes('--wipe');
  const withHistory = process.argv.includes('--history');
  if (wipeOnly || process.argv.includes('--reset')) {
    await dropDatabase(config.dbName);
    // The indexes went with the database: connect again to put them back.
    await disconnect();
    await connect(config.mongoUri, config.dbName);
    console.log(`[seed] Wiped "${config.dbName}".`);
  }
  if (wipeOnly) {
    console.log('[seed] Left empty. Open the web app to go through first-run setup.');
  } else if (await seedDemo({ historyDays: withHistory ? HISTORY_DAYS : 0, holidays: true, leave: true, announcements: true })) {
    console.log(`[seed] Created the sample company in "${config.dbName}":`);
    for (const p of DEMO_PEOPLE) console.log(`         ${p.role.padEnd(8)} ${p.email}${p.invited ? '  (temporary password: must choose a new one)' : ''}`);
    console.log('       The password of every sample account is DEMO_PASSWORD in backend/src/seed/demo.ts.');
    console.log('       Everyone is on the leave policy "Standard leave", with this leave year\'s allowance and a few sample requests.');
    console.log('       HR has posted six sample announcements: for everyone, for Sales, for managers and HR, one still to start and one that is over.');
    console.log(withHistory ? `       Their schedules started ${HISTORY_DAYS} days ago, with sample attendance for every day since. It is sample data, not anyone's real record.` : '       Their schedules start today, with no attendance yet. Add --history for three weeks of sample attendance.');
  } else {
    console.log(`[seed] "${config.dbName}" already has people in it, so nothing was changed. Use --reset to start again.`);
  }
} finally {
  await disconnect();
}
