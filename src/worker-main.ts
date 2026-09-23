import { setTimeout } from 'node:timers/promises';
import { config } from './config.js';
import { postgres } from './db.js';
import { resendMailer } from './providers.js';
import { expireOrders, deliverOne } from './jobs.js';
// Same as server.ts: schedulers run `node dist/worker-main.js` without node flags.
try {
  process.loadEnvFile();
} catch {
  // No .env file: the process environment already carries the configuration.
}
const c = config();
const db = postgres(c.DATABASE_URL);
const mailer = resendMailer(c);
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});
let lastCleanup = 0;
// One bounded pass for shared hosting, where a scheduler such as cPanel Cron ticks
// every minute instead of supervising a second long-lived process. Leases keep
// overlapping runs from delivering the same email twice.
const once = process.argv.includes('--once');
try {
  if (once) {
    const expired = await expireOrders(db);
    if (expired) console.info({ expired });
    let delivered = 0;
    while (delivered < 50 && (await deliverOne(db, mailer))) delivered++;
    if (delivered) console.info({ delivered });
  }
  while (!once && !stopping) {
    try {
      if (Date.now() - lastCleanup > 60_000) {
        const expired = await expireOrders(db);
        if (expired) console.info({ expired });
        lastCleanup = Date.now();
      }
      if (!(await deliverOne(db, mailer))) await setTimeout(1000);
    } catch (e) {
      console.error('Worker iteration failed', e);
      await setTimeout(5000);
    }
  }
} finally {
  await db.close();
}
