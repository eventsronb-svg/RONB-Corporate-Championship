import { randomUUID } from 'node:crypto';
import { type Database, one } from './db.js';
import { transition } from './orders.js';
import { type Mailer, type EmailPayload, DeliveryError } from './providers.js';
export async function expireOrders(db: Database) {
  return db.transaction(async (tx) => {
    const stale = (
      await tx.query(
        `SELECT o.* FROM orders o WHERE
   (o.status IN ('draft','phone_captured') AND o.invoiced_at IS NULL AND o.updated_at<=now()-interval '7 days')
   OR (o.status='payment_pending' AND EXISTS(SELECT 1 FROM payment_requests p WHERE p.order_id=o.id AND p.expires_at<=now()) AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.order_id=o.id))
   ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 100`,
        [],
      )
    ).rows;
    for (const order of stale) await transition(tx, order, 'expired', null, 'expired');
    await tx.query('DELETE FROM sessions WHERE expires_at<=now()');
    await tx.query('DELETE FROM oauth_states WHERE expires_at<=now()');
    return stale.length;
  });
}
export async function deliverOne(db: Database, mailer: Mailer) {
  const job = await db.transaction(async (tx) => {
    const j = await one(
      tx,
      `SELECT * FROM email_jobs WHERE (status='pending' AND available_at<=now())
   OR (status='processing' AND locked_at<now()-interval '5 minutes') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!j) return null;
    // Never replay an ambiguous send beyond the provider's 24-hour idempotency window.
    if (
      j.first_attempt_at &&
      Date.now() - new Date(j.first_attempt_at).getTime() > 23 * 60 * 60 * 1000
    ) {
      await tx.query(
        "UPDATE email_jobs SET status='failed',last_error='Retry window elapsed; admin review required' WHERE id=$1",
        [j.id],
      );
      return { expired: true };
    }
    if (j.attempts >= 5) {
      await tx.query(
        "UPDATE email_jobs SET status='failed',last_error='Maximum delivery attempts reached' WHERE id=$1",
        [j.id],
      );
      return { expired: true };
    }
    return one(
      tx,
      `UPDATE email_jobs SET status='processing',attempts=attempts+1,locked_at=now(),lease_token=$2,
   first_attempt_at=coalesce(first_attempt_at,now()) WHERE id=$1 RETURNING *`,
      [j.id, randomUUID()],
    );
  });
  if (!job) return false;
  if (job.expired) return true;
  const payload = job.payload as EmailPayload;
  let providerId: string | null = null;
  let failure: unknown = null;
  try {
    providerId = await mailer.send(payload, `email-job/${job.id}`);
  } catch (e) {
    failure = e;
  }
  await db.transaction(async (tx) => {
    const current = await one(
      tx,
      "SELECT * FROM email_jobs WHERE id=$1 AND lease_token=$2 AND status='processing' FOR UPDATE",
      [job.id, job.lease_token],
    );
    if (!current) return; // A newer worker owns a recovered lease.
    const error = failure instanceof Error ? failure.message : 'Delivery failed';
    await tx.query(
      'INSERT INTO email_log(order_id,user_id,sent_to,status,provider_message_id,error) VALUES($1,$2,$3,$4,$5,$6)',
      [
        job.order_id,
        payload.userId,
        payload.to,
        failure ? 'failed' : 'sent',
        providerId,
        failure ? error : null,
      ],
    );
    const retry =
      failure && (!(failure instanceof DeliveryError) || failure.transient) && job.attempts < 5;
    await tx.query(
      `UPDATE email_jobs SET status=$2,last_error=$3,locked_at=NULL,lease_token=NULL,available_at=now()+($4*interval '1 second') WHERE id=$1`,
      [
        job.id,
        failure ? (retry ? 'pending' : 'failed') : 'sent',
        failure ? error : null,
        Math.min(60 * 2 ** job.attempts, 3600),
      ],
    );
  });
  return true;
}
