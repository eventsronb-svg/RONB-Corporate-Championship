import { afterEach, beforeEach, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { one } from '../src/db.js';
import { deliverOne } from '../src/jobs.js';
import { DeliveryError } from '../src/providers.js';
let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});
it('accepts exactly one of two simultaneous verification decisions', async () => {
  const o = await h.submit(1);
  const results = await Promise.all([
    h.call('POST', `/admin/orders/${o.id}/verify`, { decision: 'confirmed' }, 'staff'),
    h.call(
      'POST',
      `/admin/orders/${o.id}/verify`,
      { decision: 'rejected', notes: 'Incorrect amount' },
      'admin',
    ),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(
    (await h.db.query('SELECT * FROM payment_verifications WHERE order_id=$1', [o.id])).rows,
  ).toHaveLength(1);
});
it('serializes invoice creation with sport edits without mixing the invoice and selections', async () => {
  const o = (await h.call('POST', '/orders/draft')).json();
  await h.call('PATCH', `/orders/${o.id}/sports`, {
    sports: [{ sport_id: h.sports[0].id, team_name: 'Valley XI' }],
  });
  await h.call('POST', `/orders/${o.id}/phone`, { phone_number: '9800000000' });
  const [invoice, edit] = await Promise.all([
    h.call('POST', `/orders/${o.id}/invoice`),
    h.call('PATCH', `/orders/${o.id}/sports`, {
      sports: [{ sport_id: h.sports[1].id, team_name: 'United' }],
    }),
  ]);
  expect(invoice.statusCode).toBe(200);
  expect([200, 409]).toContain(edit.statusCode);
  const final = (await h.call('GET', `/orders/${o.id}/status`)).json();
  expect(Number(final.total_amount)).toBe(
    final.items.reduce((total: number, i: any) => total + Number(i.price_at_purchase), 0),
  );
});
it('claims one email job only once across competing workers', async () => {
  const o = await h.confirm(1);
  await h.fill(o);
  await h.call('POST', `/orders/${o.id}/items/${o.items[0].id}/profile/complete`);
  const results = await Promise.all(Array.from({ length: 8 }, () => deliverOne(h.db, h.mailer)));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(h.sent).toHaveLength(1);
  expect((await h.db.query("SELECT * FROM email_log WHERE status='sent'")).rows).toHaveLength(1);
});
it('rolls back profile completion when the transactional email outbox write fails', async () => {
  const o = await h.confirm(1);
  await h.fill(o);
  await h.db
    .query(`CREATE FUNCTION reject_test_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test queue failure' USING ERRCODE='23514'; END $$;
  CREATE TRIGGER reject_test_job BEFORE INSERT ON email_jobs FOR EACH ROW EXECUTE FUNCTION reject_test_job();`);
  expect(
    (await h.call('POST', `/orders/${o.id}/items/${o.items[0].id}/profile/complete`)).statusCode,
  ).toBe(409);
  expect(
    (await one(h.db, 'SELECT * FROM order_items WHERE id=$1', [o.items[0].id]))
      ?.profile_completed_at,
  ).toBeNull();
  expect((await h.call('GET', '/teams')).json()).toHaveLength(0);
});
it('stops after five transient delivery attempts', async () => {
  const o = await h.confirm(1);
  await h.fill(o);
  await h.call('POST', `/orders/${o.id}/items/${o.items[0].id}/profile/complete`);
  let attempts = 0;
  const mailer = {
    async send(): Promise<string> {
      attempts++;
      throw new DeliveryError('Provider unavailable', true);
    },
  };
  for (let i = 0; i < 7; i++) {
    await h.db.query('UPDATE email_jobs SET available_at=now()');
    await deliverOne(h.db, mailer);
  }
  expect(attempts).toBe(5);
  expect((await one(h.db, 'SELECT * FROM email_jobs'))?.status).toBe('failed');
  expect((await h.db.query('SELECT * FROM email_log')).rows).toHaveLength(5);
});
it('prevents simultaneous super-admin demotions from removing the final active super admin', async () => {
  const invited = (
    await h.call(
      'POST',
      '/admin/admins',
      { email: 'second@example.com', role: 'super_admin' },
      'admin',
    )
  ).json();
  const results = await Promise.all([
    h.call('PATCH', `/admin/admins/${h.admin.id}`, { role: 'staff' }, 'admin'),
    h.call('PATCH', `/admin/admins/${invited.id}`, { role: 'staff' }, 'admin'),
  ]);
  expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(
    (await h.db.query("SELECT * FROM admins WHERE active AND role='super_admin'")).rows,
  ).toHaveLength(1);
});
