import { setTimeout } from 'node:timers/promises';
import { config } from './config.js';
import { postgres } from './db.js';
import { resendMailer } from './providers.js';
import { expireOrders, deliverOne } from './jobs.js';
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
try {
  while (!stopping) {
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
