import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { deliverOne } from '../src/jobs.js';
import { hash } from '../src/auth.js';
const h = await setup();
h.setIdentity({ googleId: 'e2e-captain', email: 'e2e-captain@example.com', name: 'E2E Captain' });
// Available only in this isolated fixture server, never in the application.
// A throwaway captain with no registration of its own, so a suite can build the order
// it needs instead of sharing the open one the fixture identity starts with.
h.app.post('/__test/captain', async () => {
  const token = randomUUID();
  const user = await h.db.query(
    'INSERT INTO users(google_id,email,name) VALUES($1,$2,$3) RETURNING id',
    [`test-${token}`, `test-${token}@example.com`, 'Test Captain'],
  );
  await h.db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [hash(token), user.rows[0].id],
  );
  return { token };
});
// A championship field is drawn from confirmed registrations and this fixture only
// ships one of them. A suite that drives the group draw seeds its own field here: a
// fresh captain, a confirmed order and one item per team — the exact rows the
// "Import confirmed teams" button reads.
h.app.post<{ Params: { sport: string; count: string } }>(
  '/__test/championship/:sport/:count',
  async (req, reply) => {
    const lookups: Record<string, string> = {
      basketball: "lower(name)='basketball'",
      cricket: "lower(name) LIKE 'crick%'",
      futsal: "lower(name)='futsal'",
    };
    const lookup = lookups[req.params.sport];
    if (!lookup) return reply.code(404).send({ error: 'unknown_sport' });
    const sport = await h.db.query(`SELECT id FROM sports WHERE ${lookup}`);
    if (!sport.rows[0]) return reply.code(404).send({ error: 'sport_missing' });
    const count = Number(req.params.count);
    if (!Number.isInteger(count) || count < 1 || count > 64)
      return reply.code(400).send({ error: 'bad_count' });
    // Other browser suites may already have confirmed one of the fixture teams.
    // Fill the field to the requested total instead of adding a second full field.
    const existing = (await h.db.query(
      `SELECT count(*)::int AS count FROM order_items i JOIN orders o ON o.id=i.order_id
       WHERE i.sport_id=$1 AND o.status IN ('confirmed','contacted','completed')`,
      [sport.rows[0].id],
    )).rows[0].count;
    for (let index = existing; index < count; index++) {
      const team = `${req.params.sport} draw team ${index + 1}`;
      const token = randomUUID();
      const user = await h.db.query(
        'INSERT INTO users(google_id,email,name) VALUES($1,$2,$3) RETURNING id',
        [`seed-${token}`, `seed-${token}@example.com`, team],
      );
      const order = await h.db.query(
        "INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id",
        [user.rows[0].id],
      );
      await h.db.query(
        'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name) VALUES($1,$2,0,$3)',
        [order.rows[0].id, sport.rows[0].id, team],
      );
    }
    return { teams: count };
  },
);
h.app.post('/__test/deliver', async () => {
  while (await deliverOne(h.db, h.mailer)) {}
  return { sent: h.sent.length };
});
// The mail log counts every delivery for the whole run, so a suite file that queues a
// confirmation email of its own can leave the log clean for the file that follows it.
h.app.post('/__test/mail-clear', async () => {
  while (await deliverOne(h.db, h.mailer)) {}
  h.sent.length = 0;
  return { sent: h.sent.length };
});
h.app.post<{ Params: { id: string } }>('/__test/expire/:id', async (req) => {
  await h.db.query(
    "UPDATE payment_requests SET expires_at=now()-interval '1 minute' WHERE order_id=$1",
    [req.params.id],
  );
  return { ok: true };
});
await h.submit();
await h.app.listen({ port: Number(process.env.PORT ?? 3000), host: '127.0.0.1' });
async function stop() {
  await h.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
