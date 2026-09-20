import { afterEach, beforeEach, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { passwordAdminCredentials } from './credentials.js';
import { expireOrders } from '../src/jobs.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});

it('requires one company name and exactly one sport, preserved across reloads and revisions', async () => {
  const draft = (await h.call('POST', '/orders/draft')).json();
  const sport = { sport_id: h.sports[0].id };
  for (const company_name of ['', '   ', 'x'.repeat(121)]) {
    expect(
      (await h.call('PATCH', `/orders/${draft.id}/sports`, { company_name, sports: [sport] }))
        .statusCode,
    ).toBe(400);
  }
  expect(
    (await h.call('PATCH', `/orders/${draft.id}/sports`, { sports: [sport] })).statusCode,
  ).toBe(400);
  expect(
    (
      await h.call('PATCH', `/orders/${draft.id}/sports`, {
        company_name: 'RONB Studios',
        sports: h.sports.map((s) => ({ sport_id: s.id })),
      })
    ).statusCode,
  ).toBe(400);
  const saved = await h.call('PATCH', `/orders/${draft.id}/sports`, {
    company_name: '  RONB Studios  ',
    sports: [sport],
  });
  expect(saved.statusCode).toBe(200);
  const current = (await h.call('GET', '/orders/current')).json();
  expect(current.company_name).toBe('RONB Studios');
  expect(current.items).toHaveLength(1);
  expect(current.items.every((item: any) => item.team_name === 'RONB Studios')).toBe(true);
  await h.call('POST', `/orders/${draft.id}/phone`, { phone_number: '9800000000' });
  expect((await h.call('POST', `/orders/${draft.id}/invoice`)).statusCode).toBe(200);
  expect(
    (
      await h.call('PATCH', `/orders/${draft.id}/sports`, {
        company_name: 'Different Company',
        sports: [sport],
      })
    ).statusCode,
  ).toBe(409);
  const revised = (await h.call('POST', `/orders/${draft.id}/cancel-and-revise`)).json();
  expect(revised.company_name).toBe('RONB Studios');
  expect(revised.items.every((item: any) => item.team_name === 'RONB Studios')).toBe(true);
});

async function ready(actor: string, name: string) {
  const draft = (await h.call('POST', '/orders/draft', undefined, actor)).json();
  expect(draft.resume_step).toBe('sports');
  const selected = await h.call(
    'PATCH',
    `/orders/${draft.id}/sports`,
    {
      company_name: name,
      sports: [{ sport_id: h.sports[0].id }],
    },
    actor,
  );
  expect(selected.statusCode).toBe(200);
  expect(selected.json().resume_step).toBe('contact');
  expect(
    (await h.call('POST', `/orders/${draft.id}/phone`, { phone_number: '9800000000' }, actor))
      .statusCode,
  ).toBe(200);
  return draft.id;
}

it('reserves the final slot atomically and releases it after unpaid expiry', async () => {
  await h.db.query('UPDATE sports SET max_teams=1 WHERE id=$1', [h.sports[0].id]);
  const ids = [await ready('user', 'First Team'), await ready('stranger', 'Second Team')];
  const actors = ['user', 'stranger'];
  const results = await Promise.all(
    ids.map((id, i) => h.call('POST', `/orders/${id}/invoice`, undefined, actors[i])),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const winner = results.findIndex((r) => r.statusCode === 200);
  const loser = 1 - winner;
  expect(results[loser].json().error).toBe('sport_full');
  const capacity = (await h.call('GET', '/sports'))
    .json()
    .find((s: any) => s.id === h.sports[0].id);
  expect(capacity.filled_slots).toBe(1);
  expect(capacity.max_teams).toBe(1);
  await h.call('POST', `/orders/${ids[winner]}/payment-request`, undefined, actors[winner]);
  await h.db.query(
    "UPDATE payment_requests SET expires_at=now()-interval '1 day' WHERE order_id=$1",
    [ids[winner]],
  );
  expect(await expireOrders(h.db)).toBe(1);
  expect(
    (await h.call('POST', `/orders/${ids[loser]}/invoice`, undefined, actors[loser])).statusCode,
  ).toBe(200);
  await h.db.query(
    "INSERT INTO orders(user_id,status,total_amount,invoiced_at) VALUES($1,'invoiced',0,now()-interval '2 days')",
    [winner === 0 ? h.user.id : h.stranger.id],
  );
  expect(await expireOrders(h.db)).toBe(1);
});

it('cannot lower capacity below reservations or bypass capacity by resubmitting a rejected receipt', async () => {
  const order = await h.submit(1);
  await h.call('PATCH', `/admin/sports/${h.sports[0].id}`, { max_teams: 1 }, 'admin');
  await h.call(
    'POST',
    `/admin/orders/${order.id}/verify`,
    { decision: 'rejected', notes: 'Wrong receipt' },
    'staff',
  );
  const other = await ready('stranger', 'Other Team');
  expect((await h.call('POST', `/orders/${other}/invoice`, undefined, 'stranger')).statusCode).toBe(
    200,
  );
  const file = h.multipart('receipt');
  const resubmitted = await h.call(
    'POST',
    `/orders/${order.id}/receipt`,
    file.payload,
    'user',
    file.headers,
  );
  expect(resubmitted.statusCode).toBe(409);
  expect(resubmitted.json().error).toBe('sport_full');
  expect((await h.call('GET', `/orders/${order.id}/status`)).json().status).toBe('rejected');
  await h.call('PATCH', `/admin/sports/${h.sports[0].id}`, { max_teams: 2 }, 'admin');
  expect(
    (await h.call('POST', `/orders/${order.id}/receipt`, file.payload, 'user', file.headers))
      .statusCode,
  ).toBe(200);
  const lowered = await h.call(
    'PATCH',
    `/admin/sports/${h.sports[0].id}`,
    { max_teams: 1 },
    'admin',
  );
  expect(lowered.statusCode).toBe(409);
  expect(lowered.json().error).toBe('capacity_in_use');
});

it('does not let captains cancel submitted or confirmed payments through revision', async () => {
  const order = await h.submit(1);
  expect((await h.call('POST', `/orders/${order.id}/cancel-and-revise`)).statusCode).toBe(409);
  await h.call('POST', `/admin/orders/${order.id}/verify`, { decision: 'confirmed' }, 'staff');
  expect((await h.call('POST', `/orders/${order.id}/cancel-and-revise`)).statusCode).toBe(409);
  expect((await h.call('GET', `/orders/${order.id}/status`)).json().status).toBe('confirmed');
});

it('password login respects organizer deactivation and demotion, and can be disabled', async () => {
  const login = () => h.call('POST', '/admin/auth/password', passwordAdminCredentials);
  expect((await login()).statusCode).toBe(200);
  await h.db.query("UPDATE admins SET role='staff' WHERE email='password-admin@ronb.local'");
  const demoted = await login();
  expect(demoted.statusCode).toBe(200);
  const cookie = demoted.cookies.find((c) => c.name === 'admin_session')!;
  expect(
    (
      await h.call('GET', '/admin/sports', undefined, 'admin', {
        cookie: `admin_session=${cookie.value}`,
      })
    ).statusCode,
  ).toBe(403);
  await h.db.query("UPDATE admins SET active=false WHERE email='password-admin@ronb.local'");
  expect((await login()).statusCode).toBe(403);
  expect(
    (
      await h.call('GET', '/admin/orders', undefined, 'admin', {
        cookie: `admin_session=${cookie.value}`,
      })
    ).statusCode,
  ).toBe(401);
  h.c.ADMIN_LOGIN_USERNAME = '';
  h.c.ADMIN_LOGIN_PASSWORD = '';
  expect((await login()).statusCode).toBe(503);
});
