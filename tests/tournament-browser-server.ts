// Isolated tournament verification only. Every team, payment, roster, assignment
// and result is submitted through production routes by tournament.e2e.ts.
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { hash } from '../src/auth.js';
const h = await setup();
await h.db.query("UPDATE sports SET name='Futsal' WHERE name='Football'");
h.app.post('/__test/captain', async () => {
  const token = randomUUID();
  const user = (
    await h.db.query('INSERT INTO users(google_id,email,name) VALUES($1,$2,$3) RETURNING id', [
      `tournament-${token}`,
      `${token}@example.com`,
      'Tournament Captain',
    ])
  ).rows[0];
  await h.db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [hash(token), user.id],
  );
  return { token };
});
h.app.get('/__test/evidence', async () => ({
  registrations: (
    await h.db.query(`SELECT s.name,count(*)::int AS teams,
    count(*) FILTER (WHERE i.profile_completed_at IS NOT NULL)::int AS completed_profiles,
    count(*) FILTER (WHERE o.status='confirmed')::int AS confirmed
    FROM order_items i JOIN sports s ON s.id=i.sport_id JOIN orders o ON o.id=i.order_id
    WHERE o.status IN ('confirmed','contacted','completed') GROUP BY s.name ORDER BY s.name`)
  ).rows,
  players: (
    await h.db.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE photo_url IS NOT NULL AND jersey_size IS NOT NULL)::int AS complete FROM team_players`)
  ).rows[0],
  draws: (
    await h.db.query("SELECT metadata FROM audit_logs WHERE action='futsal.third_place.draw'")
  ).rows,
}));
await h.app.listen({ port: Number(process.env.PORT ?? 3015), host: '127.0.0.1' });
async function stop() {
  await h.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
