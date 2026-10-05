// Disposable local demo server: it uses the PGlite test database, never a configured
// PostgreSQL/Neon database. Stop it with Ctrl+C when the scoring walkthrough is over.
import { setup } from '../tests/helpers.js';

const h = await setup();
await h.db.query("UPDATE sports SET name='Futsal' WHERE id=$1", [h.sports[0].id]);
for (let index = 0; index < 32; index++) {
  const order = (
    await h.db.query("INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id", [
      h.user.id,
    ])
  ).rows[0];
  await h.db.query(
    'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name,logo_url) VALUES($1,$2,0,$3,$4)',
    [
      order.id,
      h.sports[0].id,
      `Futsal Demo ${String(index + 1).padStart(2, '0')}`,
      `https://placehold.co/160x160/e8233c/ffffff?text=${index + 1}`,
    ],
  );
}
await h.call('POST', '/admin/futsal/import', {}, 'admin');
// Groups are placed by hand through the same screen the organizer uses, four teams
// at a time, and the fixtures follow that placement order.
const { teams } = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json();
for (const [index, team] of teams.entries())
  await h.call(
    'PATCH',
    `/admin/futsal/teams/${team.id}/group`,
    { group_code: 'ABCDEFGH'[Math.floor(index / 4)] },
    'admin',
  );
await h.call('POST', '/admin/futsal/generate-fixtures', {}, 'admin');

const port = Number(process.env.PORT ?? 3002);
await h.app.listen({ port, host: '127.0.0.1' });
console.log(`Futsal demo: http://localhost:${port}/futsal`);
console.log(`Organizer:   http://localhost:${port}/admin#futsal`);
console.log('Login: test-organizer / test-only-organizer-password');

async function stop() {
  await h.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
