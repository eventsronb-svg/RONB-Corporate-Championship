// Disposable local demo server. It uses an in-memory PGlite database only.
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../dist/app.js';
import { config } from '../dist/config.js';
import { migrate } from '../dist/db.js';

const p = new PGlite();
const adapter = (client) => ({
  async query(sql, values) {
    if (!values?.length) {
      const result = await client.exec(sql);
      return { rows: result.at(-1)?.rows ?? [] };
    }
    return client.query(sql, values);
  },
});
const db = {
  ...adapter(p),
  transaction: (fn) => p.transaction((tx) => fn(adapter(tx))),
  close: () => p.close(),
};
await migrate(db);
const port = Number(process.env.PORT ?? 3002);
const appOrigin = `http://localhost:${port}`;
const c = config({
  NODE_ENV: 'test',
  APP_ORIGIN: appOrigin,
  DATABASE_URL: 'demo',
  COOKIE_SECRET: 'd'.repeat(32),
  ADMIN_LOGIN_USERNAME: 'demo-organizer',
  ADMIN_LOGIN_PASSWORD: 'demo-organizer-password',
});
const storage = {
  async put() {
    return {
      key: 'team-logos/demo.webp',
      url: 'https://placehold.co/160x160/e8233c/ffffff?text=RONB',
    };
  },
  async remove() {},
  async signReceipt() {
    return '';
  },
  async signPlayerPhoto() {
    return '';
  },
};
const google = {
  authorizationUrl: () => '',
  async exchange() {
    return { googleId: 'demo', email: 'demo@example.com', name: 'Demo' };
  },
};
const app = await buildApp({ db, config: c, storage, google });
const sport = (
  await db.query("INSERT INTO sports(name,price,max_teams) VALUES('Futsal',0,24) RETURNING id")
).rows[0];
const user = (
  await db.query(
    "INSERT INTO users(google_id,email,name) VALUES('demo-captain','demo@example.com','Demo captain') RETURNING id",
  )
).rows[0];
for (let index = 0; index < 24; index++) {
  const order = (
    await db.query("INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id", [
      user.id,
    ])
  ).rows[0];
  await db.query(
    'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name,logo_url) VALUES($1,$2,0,$3,$4)',
    [
      order.id,
      sport.id,
      `Futsal Demo ${String(index + 1).padStart(2, '0')}`,
      `https://placehold.co/160x160/e8233c/ffffff?text=${index + 1}`,
    ],
  );
}
// Password login creates the organizer. Seed the competition directly, exactly as the admin buttons do.
await db.query(
  "INSERT INTO admins(email,name,role) VALUES('seed@demo.local','Demo organizer','super_admin')",
);
const entries = await db.query(
  "INSERT INTO futsal_teams(order_item_id,team_name,logo_url) SELECT i.id,i.team_name,i.logo_url FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sport_id=$1 AND o.status='confirmed' RETURNING id",
  [sport.id],
);
console.log(`Seeded ${entries.rows.length} Futsal teams for manual group assignment.`);
await app.listen({ host: '127.0.0.1', port });
console.log(`Futsal demo: ${appOrigin}/futsal`);
console.log(`Organizer:   ${appOrigin}/admin#futsal`);
console.log('Login: demo-organizer / demo-organizer-password');
async function stop() {
  await app.close();
  await db.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
