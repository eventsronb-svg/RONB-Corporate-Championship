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
  it('persists jersey sizes, validates complete rosters, and exposes them only to authorized readers', async () => {
    const order = await h.confirm();
    await h.fill(order);
    const path = `/orders/${order.id}/items/${order.items[0].id}/profile`;
    const players = ['Small player', 'Medium player', 'Large player', 'Extra large player'];
    const jersey_sizes = ['S', 'M', 'L', 'XL'];
    for (const body of [
      { players, jersey_sizes: ['XXL', 'M', 'L', 'XL'] },
      { players, jersey_sizes: ['S'] },
      { jersey_sizes },
    ]) {
      expect((await h.call('PATCH', path, body)).statusCode).toBe(400);
    }
    const saved = await h.call('PATCH', path, { players, jersey_sizes, captain_position: 2 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().jersey_sizes).toEqual(jersey_sizes);
    expect((await h.call('GET', path)).json().jersey_sizes).toEqual(jersey_sizes);
    expect((await h.call('GET', path, undefined, 'stranger')).statusCode).toBe(404);
    expect((await h.call('POST', `${path}/complete`)).statusCode).toBe(200);
    const team = (await h.call('GET', `/admin/teams/${order.id}`, undefined, 'staff')).json();
    expect(team.items).toHaveLength(1);
    expect(team.items[0]).toMatchObject({ players, jersey_sizes, captain_position: 2 });
    expect((await h.call('GET', `/admin/teams/${order.id}`)).statusCode).toBe(401);
    expect((await h.call('GET', '/admin/teams')).statusCode).toBe(401);
    expect((await h.call('GET', '/teams')).json()[0]).not.toHaveProperty('jersey_sizes');
    for (const search of ['Valley', 'Cricket', 'Anish', 'captain@example.com', '9800000000']) {
      const list = (
        await h.call('GET', `/admin/teams?search=${encodeURIComponent(search)}`, undefined, 'staff')
      ).json();
      expect(list.teams).toHaveLength(1);
      expect(list.teams[0].id).toBe(order.id);
      expect(list.teams[0].sports).toHaveLength(1);
    }
    expect(
      (await h.call('GET', '/admin/teams?offset=1&limit=1', undefined, 'staff')).json().teams,
    ).toEqual([]);
    expect(
      (await h.call('GET', `/admin/teams/${h.stranger.id}`, undefined, 'staff')).statusCode,
    ).toBe(404);
    await expect(
      h.db.query('UPDATE team_players SET jersey_size=$1 WHERE order_item_id=$2', [
        'XXL',
        order.items[0].id,
      ]),
    ).rejects.toThrow();
    const draft = await h.call('PATCH', path, { players, jersey_sizes: ['S', null, 'L', 'XL'] });
    expect(draft.json().profile_completed_at).toBeNull();
    expect((await h.call('POST', `${path}/complete`)).json().error).toBe('jersey_sizes_required');
    expect((await h.call('GET', '/teams')).json()).toEqual([]);
    expect((await h.call('PATCH', path, { players: ['Replacement'] })).json().jersey_sizes).toEqual(
      [null],
    );
  });
  it('migrates existing rosters without inventing sizes or changing completion status', async () => {
    const order = await h.confirm(1);
    await h.fill(order);
    await h.call('POST', `/orders/${order.id}/items/${order.items[0].id}/profile/complete`);
    await h.db.query('ALTER TABLE team_players DROP COLUMN jersey_size');
    await h.db.query("DELETE FROM schema_migrations WHERE name='005_player_jersey_size.sql'");
    await migrate(h.db);
    await migrate(h.db);
    const current = (await h.call('GET', `/orders/${order.id}/status`)).json();
    expect(current.items[0].jersey_sizes).toEqual([null, null, null]);
    expect(current.items[0].players).toHaveLength(3);
    expect(current.items[0].profile_completed_at).toBeTruthy();
  });
  it('gates a team until its profile is complete and sends one asynchronous confirmation', async () => {
    const order = await h.confirm();
    expect(order.total_amount).toBe('1500.25');
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
    expect(first[0].players).toEqual(['Suman Karki', 'Pratik Gurung', 'Aarav Shah']);
    expect((await h.db.query('SELECT * FROM email_jobs')).rows).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect((await h.call('GET', `/teams?sport_id=${h.sports[0].id}`)).json()).toHaveLength(1);
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
  it('shares and replaces a company logo, then completes the single team profile', async () => {
    const order = await h.confirm();
    const first = await h.fill(order, 0);
    const current = (await h.call('GET', `/orders/${order.id}/status`)).json();
    expect(current.items[0].logo_url).toBe(first.logo_url);
    const replacement = await h.fill(order, 0);
    expect(replacement.logo_url).not.toBe(first.logo_url);
    const after = (await h.call('GET', `/orders/${order.id}/status`)).json();
    expect(after.items[0].logo_url).toBe(replacement.logo_url);
    expect(
      (await h.call('POST', `/orders/${order.id}/items/${order.items[0].id}/profile/complete`))
        .statusCode,
    ).toBe(200);
    const teams = (await h.call('GET', '/teams')).json();
    expect(teams).toHaveLength(1);
    expect(teams[0].logo_url).toBe(replacement.logo_url);
  });
  it('locks the company identity and reuses its logo when registering another sport', async () => {
    const first = await h.confirm();
    await h.fill(first);
    await h.call('POST', `/orders/${first.id}/items/${first.items[0].id}/profile/complete`);
    const original = (await h.call('GET', '/teams')).json();
    expect(original).toHaveLength(1);
    expect(original[0].logo_url).toBeTruthy();

    const start = (await h.call('POST', '/orders/start')).json();
    const secondId = start.id;
    expect(start.company_locked).toBe(true);

    const renamed = await h.call('PATCH', `/orders/${secondId}/sports`, {
      company_name: 'Another Venture',
      sports: [{ sport_id: h.sports[1].id }],
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().error).toBe('company_locked');

    const selection = await h.call('PATCH', `/orders/${secondId}/sports`, {
      company_name: 'Valley Strikers',
      sports: [{ sport_id: h.sports[1].id }],
    });
    expect(selection.statusCode).toBe(200);
    const second = selection.json();
    expect(second.company_name).toBe('Valley Strikers');
    expect(second.company_locked).toBe(true);
    expect(second.items[0].team_name).toBe('Valley Strikers');
    expect(second.items[0].logo_url).toBe(original[0].logo_url);
    expect(second.phone_number).toBe('+977 9800000000');
    expect(second.resume_step).toBe('invoice');

    await h.call('POST', `/orders/${secondId}/invoice`);
    await h.call('POST', `/orders/${secondId}/payment-request`);
    const f = h.multipart('receipt');
    expect(
      (await h.call('POST', `/orders/${secondId}/receipt`, f.payload, 'user', f.headers))
        .statusCode,
    ).toBe(200);
    const confirmed = await h.call(
      'POST',
      `/admin/orders/${secondId}/verify`,
      { decision: 'confirmed' },
      'staff',
    );
    expect(confirmed.statusCode).toBe(200);
    const secondItem = confirmed.json().items[0];

    const path = `/orders/${secondId}/items/${secondItem.id}/profile`;
    const logo = h.multipart('logo');
    const replaced = await h.call('PATCH', path, logo.payload, 'user', logo.headers);
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().error).toBe('logo_locked');

    const saved = await h.call('PATCH', path, {
      players: ['Suman Karki', 'Pratik Gurung', 'Aarav Shah'],
      jersey_sizes: ['S', 'M', 'XL'],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().logo_url).toBe(original[0].logo_url);
    expect((await h.call('POST', `${path}/complete`)).statusCode).toBe(200);
    expect((await h.call('GET', '/teams')).json()).toHaveLength(2);
  });
  it('uploads player photos, renders them with the roster, and keeps them private before payment', async () => {
    const order = await h.submit();
    const photo = h.multipart('photo');
    const unconfirmed = await h.call(
      'POST',
      `/orders/${order.id}/items/${order.items[0].id}/player-photos/1`,
      photo.payload,
      'user',
      photo.headers,
    );
    expect(unconfirmed.statusCode).toBe(409);
    await h.call('POST', `/admin/orders/${order.id}/verify`, { decision: 'confirmed' }, 'staff');
    const uploaded = await h.call(
      'POST',
      `/orders/${order.id}/items/${order.items[0].id}/player-photos/1`,
      photo.payload,
      'user',
      photo.headers,
    );
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().photo_url).toMatch(/^https:\/\/player-photos\.example\/player-photos\//);
    const saved = await h.call('PATCH', `/orders/${order.id}/items/${order.items[0].id}/profile`, {
      players: ['Suman Karki', 'Pratik Gurung', 'Aarav Shah'],
      jersey_sizes: ['S', 'M', 'XL'],
      player_photos: [null, uploaded.json().photo_url, null],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().photo_urls).toEqual([null, uploaded.json().photo_url, null]);
    const status = (await h.call('GET', `/orders/${order.id}/status`)).json();
    expect(status.items[0].photo_urls[1]).toBe(uploaded.json().photo_url);
    expect(status.items[0].players[1]).toBe('Pratik Gurung');
    const detail = (await h.call('GET', `/admin/orders/${order.id}`, undefined, 'staff')).json();
    expect(detail.items[0].photo_urls[1]).toBe(uploaded.json().photo_url);
    const logo = await h.call(
      'PATCH',
      `/orders/${order.id}/items/${order.items[0].id}/profile`,
      h.multipart('logo').payload,
      'user',
      h.multipart('logo').headers,
    );
    expect(logo.statusCode).toBe(200);
    expect(
      (await h.call('POST', `/orders/${order.id}/items/${order.items[0].id}/profile/complete`))
        .statusCode,
    ).toBe(200);
    expect((await h.call('GET', '/teams')).json()[0]).not.toHaveProperty('player_photos');
  });
  it('stores the captain as a roster member and rejects positions outside the roster', async () => {
    const order = await h.confirm();
    await h.fill(order, 0);
    const path = `/orders/${order.id}/items/${order.items[0].id}/profile`;
    const saved = await h.call('PATCH', path, { captain_position: 1 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().captain_position).toBe(1);
    expect(saved.json().players).toHaveLength(3);
    expect((await h.call('PATCH', path, { captain_position: 3 })).statusCode).toBe(400);
    expect((await h.call('PATCH', path, { captain_position: -1 })).statusCode).toBe(400);
    expect((await h.call('GET', path)).json().captain_position).toBe(1);
    const changed = await h.call('PATCH', path, { players: ['New player'] });
    expect(changed.json().captain_position).toBeNull();
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
    expect((await h.call('POST', `/orders/${o.id}/invoice`)).json().total_amount).toBe('1500.25');
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
      '1500.25',
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
  it('lists existing registrations and lets the captain start a fresh one for another sport', async () => {
    const o = await h.confirm(1);
    await h.fill(o);
    await h.call('POST', `/orders/${o.id}/items/${o.items[0].id}/profile/complete`);
    let list = (await h.call('GET', '/orders')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: o.id, resume_step: 'registered' });
    expect(list[0].items[0]).toMatchObject({ sport_name: 'Cricket' });
    expect(list[0].items[0].players).toEqual(['Suman Karki', 'Pratik Gurung', 'Aarav Shah']);
    expect((await h.call('GET', '/orders', undefined, 'stranger')).json()).toEqual([]);
    // A confirmed order is still "open" for draft(), so Add sports must use start().
    const second = (await h.call('POST', '/orders/start')).json();
    expect(second.id).not.toBe(o.id);
    expect(second.resume_step).toBe('sports');
    expect((await h.call('POST', '/orders/start')).json().id).toBe(second.id);
    const picked = await h.call('PATCH', `/orders/${second.id}/sports`, {
      company_name: 'Valley Strikers',
      sports: [{ sport_id: h.sports[1].id }],
    });
    expect(picked.statusCode).toBe(200);
    list = (await h.call('GET', '/orders')).json();
    expect(list).toHaveLength(2);
    expect(
      (list as { items: { sport_name: string }[] }[]).map((r) => r.items[0].sport_name).sort(),
    ).toEqual(['Cricket', 'Football']);
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
  it('issues the same payment code to the same account across separate single-sport registrations', async () => {
    const codes: string[] = [];
    let order = (await h.call('POST', '/orders/draft')).json();
    for (let i = 0; i < 3; i++) {
      const selection = await h.call('PATCH', `/orders/${order.id}/sports`, {
        company_name: `Valley Strikers ${i + 1}`,
        sports: [{ sport_id: h.sports[i].id }],
      });
      expect(selection.statusCode).toBe(200);
      expect(selection.json().items).toHaveLength(1);
      expect(selection.json().items[0].sport_id).toBe(h.sports[i].id);
      await h.call('POST', `/orders/${order.id}/phone`, { phone_number: '+977 9800000000' });
      await h.call('POST', `/orders/${order.id}/invoice`);
      const payment = await h.call('POST', `/orders/${order.id}/payment-request`);
      expect(payment.statusCode).toBe(200);
      codes.push(payment.json().unique_code);
      expect(codes[i]).toMatch(/^RONB-\d{5}$/);
      if (i < 2) {
        order = (
          await h.call('POST', `/orders/${order.id}/cancel-and-revise`, undefined, 'user')
        ).json();
      }
    }
    expect(codes[0]).toBe(codes[1]);
    expect(codes[1]).toBe(codes[2]);
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
      '1500.25',
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
    const before = (await h.db.query('SELECT name FROM schema_migrations ORDER BY name')).rows;
    await migrate(h.db);
    expect((await h.db.query('SELECT name FROM schema_migrations ORDER BY name')).rows).toEqual(
      before,
    );
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
