// A completely local copy of the app for clicking through the registration flow by hand.
//
//   npm run local            (or: npx tsx scripts/local-server.ts)
//
// It never reads .env, on purpose: the database is an embedded PGlite instance held in
// memory, uploads live in a Map that this same process serves back, Google sign-in bounces
// straight to our own callback, and email is printed instead of posted. Nothing in here can
// reach the Neon database, the object storage buckets or Resend.
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { deliverOne } from '../src/jobs.js';
import { migrate, type Database, type Queryable, type Row } from '../src/db.js';
import type { GoogleProvider, Mailer, Storage } from '../src/providers.js';
import { seedChampionships } from './seed-tournament.js';

const port = Number(process.env.PORT ?? 4000);
const origin = `http://localhost:${port}`;

// Embedded Postgres: no server to install, no Docker, wiped when this process exits.
const client = new PGlite();
const adapter = (tx: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
  async query<T extends Row = Row>(sql: string, values?: any[]) {
    if (!values?.length) {
      const results = await tx.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    }
    return tx.query<T>(sql, values);
  },
});
const db: Database = {
  ...adapter(client),
  transaction: (fn) => client.transaction((tx) => fn(adapter(tx))),
  close: () => client.close(),
};
await migrate(db);

// Explicit values only: config() is handed a literal object, so a .env on disk cannot
// point this server at the production database or buckets.
const c = config({
  NODE_ENV: 'development',
  PORT: String(port),
  APP_ORIGIN: origin,
  DATABASE_URL: 'embedded-pglite',
  COOKIE_SECRET: 'local-demo-cookie-secret-not-for-production',
  ADMIN_LOGIN_USERNAME: 'localadmin',
  ADMIN_LOGIN_PASSWORD: 'local-demo-admin-2026',
});

// Uploaded bytes stay in memory. Receipts and photos are referenced by their bare key (the
// API hands that key to the signing methods), while a logo is stored straight on the order
// and needs a usable URL the moment it is saved.
const files = new Map<string, { body: Buffer; mime: string }>();
const storage: Storage = {
  async put(kind, buffer, mime) {
    const folder =
      kind === 'receipt' ? 'receipts' : kind === 'photo' ? 'player-photos' : 'team-logos';
    const key = `${folder}/${randomUUID()}.${mime === 'application/pdf' ? 'pdf' : 'webp'}`;
    files.set(key, { body: buffer, mime });
    return { key, url: kind === 'logo' ? `/local-files/${key}` : key };
  },
  async remove(_kind, key) {
    files.delete(key);
  },
  async signReceipt(key) {
    return `/local-files/${key}`;
  },
  async signPlayerPhoto(key) {
    return `/local-files/${key}`;
  },
  async read(_kind, key) {
    const stored = files.get(key);
    return stored ? { body: stored.body, mime: stored.mime } : undefined;
  },
};

// Sign-in that never leaves the machine: the server is redirected to its own callback with
// the state it just issued, so the state check passes exactly as it would with Google.
const google: GoogleProvider = {
  authorizationUrl(redirectUri, state) {
    return `${redirectUri}?code=local-demo&state=${encodeURIComponent(state)}`;
  },
  async exchange() {
    return { googleId: 'local-captain', email: 'captain@example.com', name: 'Local Captain' };
  },
};

// Email is logged instead of sent; deliverOne() pulls it out of the queue like the worker.
const mailer: Mailer = {
  async send(payload) {
    console.log(`\n  mail -> ${payload.to}\n  ${payload.subject}\n`);
    return `local-${randomUUID()}`;
  },
};

const app = await buildApp({ db, config: c, google, storage });

// Hand the in-memory bytes back so logos, receipts and player photos actually render.
const serveFile = async (req: FastifyRequest, reply: FastifyReply) => {
  const stored = files.get((req.params as Record<string, string>)['*']);
  if (!stored) return reply.code(404).send({ error: 'not_found', message: 'File not found' });
  return reply
    .header('Content-Type', stored.mime)
    .header('Content-Disposition', 'inline')
    .header('Cache-Control', 'no-store')
    .send(stored.body);
};
for (const prefix of ['/local-files/*', '/team-logos/*', '/player-photos/*', '/receipts/*'])
  app.get(prefix, serveFile);

// On Vercel, any file under public/ is served outside the route table (that is how
// /favicon.svg gets its bytes). The standalone app only mounts /assets/, so stand in for
// that fallback here rather than leaving ordinary page assets to 404.
const publicRoot = resolve('public');
const typeFor = (file: string) =>
  ({
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
  })[extname(file).toLowerCase()] ?? 'application/octet-stream';
app.setNotFoundHandler(async (req, reply) => {
  const pathname = new URL(req.url, origin).pathname;
  const candidate = resolve(
    publicRoot,
    pathname === '/favicon.ico' ? 'favicon.svg' : pathname.slice(1),
  );
  const inside = relative(publicRoot, candidate);
  if (
    (req.method !== 'GET' && req.method !== 'HEAD') ||
    !inside ||
    inside.startsWith('..') ||
    inside.includes(`..${sep}`) ||
    !existsSync(candidate) ||
    !statSync(candidate).isFile()
  )
    return reply.code(404).send({ error: 'not_found', message: 'Not found' });
  return reply.header('Content-Type', typeFor(candidate)).send(createReadStream(candidate));
});

// The three tournament sports a fresh event needs before a captain can register.
await db.query(
  "INSERT INTO sports(name, price) VALUES('Futsal',2000.50),('Cricksal',1500.25),('Basketball',1000)",
);
await db.query(
  `INSERT INTO events(title, description, start_date, end_date, venue)
   VALUES('RONB Corporate Championship','A weekend of team sports','2026-10-10T08:00:00Z','2026-10-13T18:00:00Z','Kathmandu')`,
);

// Full championships for every sport: the field is registered, drawn and played out
// except for the last group fixture, the one that draws the knockout bracket.
await seedChampionships(db, files);

setInterval(() => {
  void (async () => {
    try {
      while (await deliverOne(db, mailer)) continue;
    } catch (error) {
      console.error('email drain failed:', error);
    }
  })();
}, 3000);

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
async function shutdown() {
  await app.close();
  await db.close();
  process.exit(0);
}

await app.listen({ port, host: '127.0.0.1' });
console.log(`
  RONB local demo — everything in memory, nothing outside this machine.

  Captain flow   ${origin}/register
  Organizer desk ${origin}/admin   (localadmin / local-demo-admin-2026)

  - "Sign in with Google" bounces straight back; no Google account is involved.
  - Futsal (32), Cricksal (20) and Basketball (16) are fully drawn with every
    group fixture except the last one played. End that last one on the desk and
    the knockout bracket draws itself.
  - Two pending payments per sport sit in the review queue for desk practice.
  - Confirm your own payment from the organizer desk to reach the team profile.
  - Restarting this process wipes every row and file: that is the reset button.
  - .env is ignored, so no Neon, no buckets and no Resend are ever touched.

  Press Ctrl+C to stop.
`);
