import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { one, migrate } from '../src/db.js';
import { deliverOne, expireOrders } from '../src/jobs.js';
import { DeliveryError } from '../src/providers.js';
import { passwordAdminCredentials } from './credentials.js';
let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
}, 30000);
afterEach(async () => {
  await h?.close();
});
describe('registration and publication', () => {
  it('runs the multi-sport flow, gates each team, and sends one asynchronous confirmation', async () => {
    const order = await h.confirm();
    expect(order.total_amount).toBe('3500.75');
    expect((await h.call('GET', '/teams')).json()).toEqual([]);
    expect((await h.db.query('SELECT * FROM email_jobs')).rows).toHaveLength(0);
    expect((await h.call('GET', '/orders/current')).json().resume_step).toBe('team_profile');
    expect(
      (await h.call('POST', `/orders/${order.id}/items/${order.items[0].id}/profile/complete`))
        .statusCode,
    ).toBe(409);
    await h.fill(order, 0);
    expect((await h.call('GET', '/teams')).json()).toHaveLength(0);
    await h.call('POST', `/orders/${order.id}/items/${order.items[0].id}/profile/complete`);
    const first = (await h.call('GET', '/teams')).json();
    expect(first).toHaveLength(1);
    expect(first[0].team_name).toBe('Valley Strikers');
    expect(first[0]).not.toHaveProperty('user_id');
    expect(first[0].players).toEqual(['Suman Karki', 'Pratik Gurung']);
    expect((await h.db.query('SELECT * FROM email_jobs')).rows).toHaveLength(0);
    await h.fill(order, 1);
    const finish = await Promise.all(
      [0, 1, 1].map((i) =>
        h.call('POST', `/orders/${order.id}/items/${order.items[i].id}/profile/complete`),
      ),
    );
    expect(finish.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect((await h.db.query('SELECT * FROM email_jobs')).rows).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect((await h.call('GET', `/teams?sport_id=${h.sports[1].id}`)).json()).toHaveLength(1);
    await deliverOne(h.db, h.mailer);
    await deliverOne(h.db, h.mailer);
    expect(h.sent).toHaveLength(1);
    const logs = (await h.db.query('SELECT * FROM email_log')).rows;
    expect(logs[0].status).toBe('sent');
    expect(logs[0].provider_message_id).toBe('resend-message-id');
    expect((await h.call('GET', '/orders/current')).json().resume_step).toBe('registered');
    const detail = (await h.call('GET', `/admin/orders/${order.id}`, undefined, 'staff')).json();
    expect(detail.receipts[0].signed_url).toContain('?signed=1');
    expect(detail.receipts[0]).not.toHaveProperty('file_url');
    expect(detail.timeline.at(-1).to_status).toBe('confirmed');
  });
  it('serializes double draft creation and prevents duplicate open orders in the database', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.call('POST', '/orders/draft')),
    );
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    await expect(
      h.db.query('INSERT INTO orders(user_id) VALUES($1)', [h.user.id]),
    ).rejects.toThrow();
  });
  it('freezes invoice prices and names even against direct SQL, then revises with fresh prices', async () => {
    const o = await h.invoice();
    expect(
      (
        await h.call('PATCH', `/orders/${o.id}/sports`, {
          company_name: 'Changed',
          sports: [{ sport_id: h.sports[0].id }],
        })
      ).statusCode,
    ).toBe(409);
    await h.call('PATCH', `/admin/sports/${h.sports[0].id}`, { price: '1700.00' }, 'admin');
    expect((await h.call('POST', `/orders/${o.id}/invoice`)).json().total_amount).toBe('3500.75');
    for (const sql of [
      'UPDATE orders SET total_amount=1 WHERE id=$1',
      'UPDATE orders SET invoiced_at=NULL,total_amount=NULL WHERE id=$1',
      'DELETE FROM order_items WHERE order_id=$1',
      "UPDATE order_items SET team_name='Changed' WHERE order_id=$1",
      'UPDATE order_items SET price_at_purchase=1 WHERE order_id=$1',
    ])
      await expect(h.db.query(sql, [o.id])).rejects.toThrow();
    const revised = (await h.call('POST', `/orders/${o.id}/cancel-and-revise`)).json();
    expect(revised.id).not.toBe(o.id);
    expect(revised.status).toBe('draft');
    expect(revised.items[0].price_at_purchase).toBe('1700.00');
    expect((await one(h.db, 'SELECT * FROM orders WHERE id=$1', [o.id]))?.total_amount).toBe(
      '3500.75',
    );
  });
  it('takes current prices at invoice time and refuses inactive sports', async () => {
    const o = (await h.call('POST', '/orders/draft')).json();
    await h.call('PATCH', `/orders/${o.id}/sports`, {
      company_name: 'Valley XI',
      sports: [{ sport_id: h.sports[0].id }],
    });
    await h.call('POST', `/orders/${o.id}/phone`, { phone_number: '9800000000' });
    await h.call('PATCH', `/admin/sports/${h.sports[0].id}`, { price: '999.99' }, 'admin');
    expect((await h.call('POST', `/orders/${o.id}/invoice`)).json().total_amount).toBe('999.99');
    await h.call('DELETE', `/admin/sports/${h.sports[0].id}`, undefined, 'admin');
    const next = (await h.call('POST', `/orders/${o.id}/cancel-and-revise`)).json();
    expect(next.items).toHaveLength(0);
    expect(
      (
        await h.call('PATCH', `/orders/${next.id}/sports`, {
          company_name: 'Valley XI',
          sports: [{ sport_id: h.sports[0].id }],
        })
      ).statusCode,
    ).toBe(400);
  });
  it('resumes rejected orders and retains all receipts and rejection notes', async () => {
    const o = await h.submit();
    expect(
      (await h.call('POST', `/admin/orders/${o.id}/verify`, { decision: 'rejected' }, 'staff'))
        .statusCode,
    ).toBe(400);
    await h.call(
      'POST',
      `/admin/orders/${o.id}/verify`,
      { decision: 'rejected', notes: 'Amount is short by 100' },
      'staff',
    );
    const current = (await h.call('GET', '/orders/current')).json();
    expect(current.id).toBe(o.id);
    expect(current.rejection.notes).toContain('100');
    const f = h.multipart('receipt');
    const r = await h.call('POST', `/orders/${o.id}/receipt`, f.payload, 'user', f.headers);
    expect(r.json().status).toBe('receipt_submitted');
    expect(
      (await h.db.query('SELECT * FROM receipts WHERE order_id=$1', [o.id])).rows,
    ).toHaveLength(2);
  });
  it('blocks reopening a rejected order if a newer open order exists and cleans the uploaded file', async () => {
    const o = await h.submit();
    await h.call(
      'POST',
      `/admin/orders/${o.id}/verify`,
      { decision: 'rejected', notes: 'Wrong amount' },
      'staff',
    );
    const next = (await h.call('POST', '/orders/draft')).json();
    expect(next.id).not.toBe(o.id);
    expect((await h.call('GET', '/orders/current')).json().id).toBe(next.id);
    const f = h.multipart('receipt');
    expect(
      (await h.call('POST', `/orders/${o.id}/receipt`, f.payload, 'user', f.headers)).statusCode,
    ).toBe(409);
    expect(h.removed).toHaveLength(1);
  });
  it('allows profiles after contacted/completed and hides teams after cancellation', async () => {
    const o = await h.confirm(1);
    await h.call('POST', `/admin/orders/${o.id}/contact`, { notes: 'Called captain' }, 'staff');
    await h.call('POST', `/admin/orders/${o.id}/complete`, {}, 'staff');
    expect((await h.call('GET', '/orders/current')).json()).toBe(null);
    await h.fill(o);
    expect(
      (await h.call('POST', `/orders/${o.id}/items/${o.items[0].id}/profile/complete`)).statusCode,
    ).toBe(200);
    expect((await h.call('GET', '/teams')).json()).toHaveLength(1);
    await h.call(
      'POST',
      `/admin/orders/${o.id}/cancel`,
      { reason: 'Registration withdrawn' },
      'admin',
    );
    expect((await h.call('GET', '/teams')).json()).toHaveLength(0);
  });
});
describe('authorization and validation', () => {
  it('protects order ownership, profile ownership, roles, and same-origin mutations', async () => {
    const o = await h.invoice();
    expect((await h.app.inject('/orders/current')).statusCode).toBe(401);
    expect((await h.call('GET', `/orders/${o.id}/status`, undefined, 'stranger')).statusCode).toBe(
      404,
    );
    expect(
      (await h.call('POST', `/orders/${o.id}/invoice`, undefined, 'stranger')).statusCode,
    ).toBe(404);
    expect((await h.call('GET', `/orders/${o.id}/items/${o.items[0].id}/profile`)).statusCode).toBe(
      409,
    );
    expect(
      (await h.call('POST', '/admin/sports', { name: 'Tennis', price: 500 }, 'staff')).statusCode,
    ).toBe(403);
    expect(
      (await h.call('POST', `/admin/orders/${o.id}/cancel`, { reason: 'Cancel' }, 'staff'))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await h.call('POST', '/orders/draft', undefined, 'user', {
          origin: 'https://attacker.example',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/orders/draft',
          headers: { cookie: 'session=user' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('validates identifiers, money, selections and files', async () => {
    expect((await h.call('GET', '/orders/not-a-uuid/status')).statusCode).toBe(400);
    expect(
      (await h.call('POST', '/admin/sports', { name: 'Tennis', price: 1.001 }, 'admin')).statusCode,
    ).toBe(400);
    expect(
      (await h.call('POST', '/admin/sports', { name: 'Tennis', price: -1 }, 'admin')).statusCode,
    ).toBe(400);
    const o = (await h.call('POST', '/orders/draft')).json();
    const same = { sport_id: h.sports[0].id };
    expect(
      (
        await h.call('PATCH', `/orders/${o.id}/sports`, {
          company_name: 'Valley',
          sports: [same, same],
        })
      ).statusCode,
    ).toBe(400);
    expect((await h.call('POST', `/orders/${o.id}/invoice`)).statusCode).toBe(409);
    const submitted = await h.submit();
    const f = h.multipart('receipt', Buffer.from('<svg onload="alert(1)"></svg>'));
    expect(
      (await h.call('POST', `/orders/${submitted.id}/receipt`, f.payload, 'user', f.headers))
        .statusCode,
    ).toBe(400);
    expect(h.files.size).toBe(1);
  });
  it('keeps payment request idempotent and blocks expired code uploads', async () => {
    const o = await h.invoice();
    const first = await h.call('POST', `/orders/${o.id}/payment-request`);
    const second = await h.call('POST', `/orders/${o.id}/payment-request`);
    expect(first.json().id).toBe(second.json().id);
    expect(first.json().bank_details).toBe(
      'Bank Name: Nabil Bank\nBranch: Teendhara\nAccount: 01701017503541',
    );
    await h.db.query(
      "UPDATE payment_requests SET expires_at=now()-interval '1 second' WHERE order_id=$1",
      [o.id],
    );
    const f = h.multipart('receipt');
    expect(
      (await h.call('POST', `/orders/${o.id}/receipt`, f.payload, 'user', f.headers)).statusCode,
    ).toBe(409);
  });
  it('prevents removal of the last super admin and revokes inactive admins immediately', async () => {
    expect(
      (await h.call('PATCH', `/admin/admins/${h.admin.id}`, { active: false }, 'admin')).statusCode,
    ).toBe(409);
    expect(
      (await h.call('PATCH', `/admin/admins/${h.admin.id}`, { role: 'staff' }, 'admin')).statusCode,
    ).toBe(409);
    await h.call('PATCH', `/admin/admins/${h.staff.id}`, { active: false }, 'admin');
    expect((await h.call('GET', '/admin/me', undefined, 'staff')).statusCode).toBe(401);
  });
  it('edits event content, validates dates, filters the queue and audits mutations', async () => {
    expect(
      (await h.call('PATCH', '/admin/event', { venue: 'Pokhara Stadium' }, 'admin')).statusCode,
    ).toBe(200);
    expect((await h.call('GET', '/event')).json().venue).toBe('Pokhara Stadium');
    expect(
      (await h.call('PATCH', '/admin/event', { end_date: '2020-01-01T00:00:00Z' }, 'admin'))
        .statusCode,
    ).toBe(400);
    const o = await h.submit();
    expect(
      (await h.call('GET', '/admin/orders?search=Valley', undefined, 'staff')).json().orders,
    ).toHaveLength(1);
    expect(
      (await h.call('GET', `/admin/orders?sport_id=${h.sports[2].id}`, undefined, 'staff')).json()
        .orders,
    ).toHaveLength(0);
    expect((await h.call('POST', `/admin/orders/${o.id}/review`, {}, 'staff')).json().status).toBe(
      'under_review',
    );
    expect((await h.db.query('SELECT * FROM audit_logs')).rows.map((r) => r.action)).toEqual([
      'event.update',
      'order.review',
    ]);
  });
});
describe('background jobs', () => {
  it('expires idle drafts and unpaid codes, preserving invoices and submitted receipts', async () => {
    const o = await h.invoice();
    await h.call('POST', `/orders/${o.id}/payment-request`);
    await h.db.query(
      "UPDATE payment_requests SET expires_at=now()-interval '1 day' WHERE order_id=$1",
      [o.id],
    );
    await h.db.query("INSERT INTO orders(user_id,updated_at) VALUES($1,now()-interval '8 days')", [
      h.stranger.id,
    ]);
    expect(await expireOrders(h.db)).toBe(2);
    expect((await one(h.db, 'SELECT * FROM orders WHERE id=$1', [o.id]))?.total_amount).toBe(
      '3500.75',
    );
    const revised = (await h.call('POST', `/orders/${o.id}/cancel-and-revise`)).json();
    expect(revised.status).toBe('draft');
    const submitted = await h.submit();
    await h.db.query(
      "UPDATE payment_requests SET expires_at=now()-interval '1 day' WHERE order_id=$1",
      [submitted.id],
    );
    expect(await expireOrders(h.db)).toBe(0);
  });
  it('retries transient email failures with the same key and never changes order state', async () => {
    const o = await h.confirm(1);
    await h.fill(o);
    await h.call('POST', `/orders/${o.id}/items/${o.items[0].id}/profile/complete`);
    const keys: string[] = [];
    const fail = {
      async send(_p: unknown, key: string): Promise<string> {
        keys.push(key);
        throw new DeliveryError('Temporarily unavailable', true);
      },
    };
    await deliverOne(h.db, fail);
    expect((await one(h.db, 'SELECT * FROM email_jobs'))?.status).toBe('pending');
    expect((await one(h.db, 'SELECT status FROM orders WHERE id=$1', [o.id]))?.status).toBe(
      'confirmed',
    );
    await h.db.query('UPDATE email_jobs SET available_at=now()');
    await deliverOne(h.db, h.mailer);
    expect(h.sent[0].key).toBe(keys[0]);
    expect(
      (await h.db.query('SELECT status FROM email_log ORDER BY created_at')).rows.map(
        (r) => r.status,
      ),
    ).toEqual(['failed', 'sent']);
    expect(
      (await h.call('POST', `/admin/orders/${o.id}/resend-email`, {}, 'staff')).statusCode,
    ).toBe(200);
    await deliverOne(h.db, h.mailer);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].key).not.toBe(keys[0]);
    expect(
      (await h.call('POST', `/admin/orders/${o.id}/resend-email`, {}, 'staff')).statusCode,
    ).toBe(429);
  });
  it('does not send early, stops permanent failures and honors the idempotency window', async () => {
    const o = await h.confirm(1);
    expect(
      (await h.call('POST', `/admin/orders/${o.id}/resend-email`, {}, 'staff')).statusCode,
    ).toBe(409);
    await h.fill(o);
    await h.call('POST', `/orders/${o.id}/items/${o.items[0].id}/profile/complete`);
    await deliverOne(h.db, {
      async send() {
        throw new DeliveryError('Invalid sender', false);
      },
    });
    expect((await one(h.db, 'SELECT * FROM email_jobs'))?.status).toBe('failed');
    await h.db.query(
      "UPDATE email_jobs SET status='processing',locked_at=now()-interval '25 hours',first_attempt_at=now()-interval '25 hours'",
    );
    await deliverOne(h.db, h.mailer);
    expect(h.sent).toHaveLength(0);
    expect((await one(h.db, 'SELECT * FROM email_jobs'))?.last_error).toContain('Retry window');
  });
  it('applies migrations idempotently', async () => {
    await migrate(h.db);
    expect((await h.db.query('SELECT * FROM schema_migrations')).rows).toHaveLength(2);
  });
});
describe('Google OAuth sessions', () => {
  async function start(kind = 'user') {
    const prefix = kind === 'admin' ? '/admin/auth' : '/auth';
    const r = await h.app.inject(`${prefix}/google`);
    const state = new URL(r.headers.location!).searchParams.get('state');
    const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return { prefix, state, cookie };
  }
  it('issues a super-admin session for the password administrator', async () => {
    const rejected = await h.app.inject({
      method: 'POST',
      url: '/admin/auth/password',
      headers: { origin: h.c.APP_ORIGIN },
      payload: { username: passwordAdminCredentials.username, password: 'wrong-password' },
    });
    expect(rejected.statusCode).toBe(401);
    const result = await h.app.inject({
      method: 'POST',
      url: '/admin/auth/password',
      headers: { origin: h.c.APP_ORIGIN },
      payload: passwordAdminCredentials,
    });
    expect(result.statusCode).toBe(200);
    const cookie = result.cookies.find((entry) => entry.name === 'admin_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(
      (
        await h.app.inject({
          url: '/admin/me',
          headers: { cookie: `${cookie.name}=${cookie.value}` },
        })
      ).json().role,
    ).toBe('super_admin');
  });
  it('binds state to the browser, consumes it once, and creates a captain session', async () => {
    const s = await start();
    expect(
      (await h.app.inject(`${s.prefix}/google/callback?code=valid&state=${s.state}`)).statusCode,
    ).toBe(401);
    const result = await h.app.inject({
      method: 'POST',
      url: `${s.prefix}/google/callback`,
      headers: { cookie: s.cookie, origin: h.c.APP_ORIGIN },
      payload: { code: 'valid', state: s.state },
    });
    expect(result.statusCode).toBe(200);
    expect(result.cookies.some((c) => c.name === 'session' && c.httpOnly)).toBe(true);
    expect(
      (
        await h.app.inject({
          url: `${s.prefix}/google/callback?code=valid&state=${s.state}`,
          headers: { cookie: s.cookie },
        })
      ).statusCode,
    ).toBe(401);
    const browser = await start();
    const redirect = await h.app.inject({
      url: `${browser.prefix}/google/callback?code=valid&state=${browser.state}`,
      headers: { cookie: browser.cookie },
    });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/register');
    expect(redirect.cookies.some((c) => c.name === 'session' && c.httpOnly)).toBe(true);
  });
  it('refuses uninvited admin accounts without creating a regular user', async () => {
    const s = await start('admin');
    const result = await h.app.inject({
      url: `${s.prefix}/google/callback?code=valid&state=${s.state}`,
      headers: { cookie: s.cookie },
    });
    expect(result.statusCode).toBe(403);
    expect(await one(h.db, "SELECT * FROM users WHERE google_id='google-captain'")).toBeUndefined();
  });
  it('accepts allowlisted admins and records login and logout', async () => {
    h.setIdentity({ googleId: 'google-admin', email: 'admin@example.com', name: 'Admin' });
    const s = await start('admin');
    const result = await h.app.inject({
      url: `${s.prefix}/google/callback?code=valid&state=${s.state}`,
      headers: { cookie: s.cookie },
    });
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe('/admin');
    const cookie = result.cookies.find((c) => c.name === 'admin_session')!;
    expect(
      (
        await h.app.inject({
          url: '/admin/me',
          headers: { cookie: `${cookie.name}=${cookie.value}` },
        })
      ).json().role,
    ).toBe('super_admin');
    await h.app.inject({
      method: 'POST',
      url: '/admin/auth/logout',
      headers: { cookie: `${cookie.name}=${cookie.value}`, origin: h.c.APP_ORIGIN },
    });
    expect(
      (
        await h.app.inject({
          url: '/admin/me',
          headers: { cookie: `${cookie.name}=${cookie.value}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await h.db.query('SELECT action FROM audit_logs ORDER BY created_at')).rows.map(
        (r) => r.action,
      ),
    ).toEqual(['auth.login', 'auth.logout']);
  });
});
