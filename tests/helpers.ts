import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { type Database, type Queryable, type Row, migrate, one, postgres } from '../src/db.js';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { hash } from '../src/auth.js';
import type { GoogleProvider, Storage, Mailer } from '../src/providers.js';
import { passwordAdminCredentials } from './credentials.js';
export async function setup() {
  let db: Database;
  if (process.env.TEST_DATABASE_URL) {
    if (!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('TEST_DATABASE_URL must point to a disposable database ending in _test');
    db = postgres(process.env.TEST_DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
  } else {
    const p = new PGlite();
    const adapter = (client: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
      async query<T extends Row = Row>(sql: string, values?: any[]) {
        if (!values?.length) {
          const results = await client.exec(sql);
          return { rows: (results.at(-1)?.rows ?? []) as T[] };
        }
        return client.query<T>(sql, values);
      },
    });
    db = {
      ...adapter(p),
      transaction: (fn) => p.transaction((tx) => fn(adapter(tx))),
      close: () => p.close(),
    };
  }
  await migrate(db);
  const appOrigin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:3000';
  const c = config({
    NODE_ENV: 'test',
    APP_ORIGIN: appOrigin,
    DATABASE_URL: 'test',
    COOKIE_SECRET: 'a'.repeat(32),
    ADMIN_LOGIN_USERNAME: passwordAdminCredentials.username,
    ADMIN_LOGIN_PASSWORD: passwordAdminCredentials.password,
  });
  const files = new Map<string, Buffer>();
  const removed: string[] = [];
  const storage: Storage = {
    async put(kind, buffer, mime) {
      const folder =
        kind === 'receipt' ? 'receipts' : kind === 'photo' ? 'player-photos' : 'team-logos';
      const key = `${folder}/${randomUUID()}.${mime === 'application/pdf' ? 'pdf' : 'webp'}`;
      files.set(key, buffer);
      const host = kind === 'receipt' || kind === 'photo' ? key : `https://logos.example/${key}`;
      return { key, url: host };
    },
    async remove(_kind, key) {
      files.delete(key);
      removed.push(key);
    },
    async signReceipt(key) {
      return `https://private.example/${key}?signed=1`;
    },
    async signPlayerPhoto(key) {
      return `https://private.example/${key}?signed=1`;
    },
  };
  let identity = {
    googleId: 'google-captain',
    email: 'captain@example.com',
    name: 'Anish Shrestha',
  };
  const google: GoogleProvider = {
    authorizationUrl(uri, state, challenge) {
      return `https://accounts.google.com/auth?state=${state}&redirect_uri=${encodeURIComponent(uri)}&code_challenge=${challenge}`;
    },
    async exchange() {
      return identity;
    },
  };
  const sent: { payload: unknown; key: string }[] = [];
  const mailer: Mailer = {
    async send(payload, key) {
      sent.push({ payload, key });
      return 'resend-message-id';
    },
  };
  const app = await buildApp({ db, config: c, google, storage });
  const user = (await one(
    db,
    "INSERT INTO users(google_id,email,name) VALUES('u1','captain@example.com','Anish Shrestha') RETURNING *",
  ))!;
  const stranger = (await one(
    db,
    "INSERT INTO users(google_id,email,name) VALUES('u2','other@example.com','Maya Rai') RETURNING *",
  ))!;
  const admin = (await one(
    db,
    "INSERT INTO admins(email,role) VALUES('admin@example.com','super_admin') RETURNING *",
  ))!;
  const staff = (await one(
    db,
    "INSERT INTO admins(email,role) VALUES('staff@example.com','staff') RETURNING *",
  ))!;
  const actors = { user, stranger, admin, staff };
  for (const [key, actor] of Object.entries(actors)) {
    const kind = key === 'admin' || key === 'staff' ? 'admin' : 'user';
    await db.query(
      `INSERT INTO sessions(token_hash,${kind}_id,expires_at) VALUES($1,$2,now()+interval '1 day')`,
      [hash(key), actor.id],
    );
  }
  const sports = (
    await db.query(
      "INSERT INTO sports(name,price) VALUES('Cricksal',1500.25),('Football',2000.50),('Basketball',1000) RETURNING *",
    )
  ).rows;
  await db.query(
    "INSERT INTO events(title,description,start_date,end_date,venue) VALUES('Ronb Sports Meet','A weekend of team sports','2026-12-01T08:00:00Z','2026-12-02T18:00:00Z','Kathmandu')",
  );
  const call = async (
    method: string,
    url: string,
    payload?: any,
    actor = 'user',
    headers: Record<string, string> = {},
  ) => {
    return app.inject({
      method: method as any,
      url,
      payload,
      headers: {
        origin: c.APP_ORIGIN,
        cookie: `${actor === 'admin' || actor === 'staff' ? 'admin_session' : 'session'}=${actor}`,
        ...headers,
      },
    });
  };
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#759585' } })
    .png()
    .toBuffer();
  function multipart(
    field: string,
    buffer = png,
    extra?: { name: string; value: string } | { name: string; value: string }[],
  ) {
    const boundary = '----RonbBoundary';
    const pieces = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="upload.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      buffer,
      Buffer.from('\r\n'),
    ];
    const extras = Array.isArray(extra) ? extra : extra ? [extra] : [];
    for (const item of extras)
      pieces.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${item.name}"\r\n\r\n${item.value}\r\n`,
        ),
      );
    pieces.push(Buffer.from(`--${boundary}--\r\n`));
    return {
      payload: Buffer.concat(pieces),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }
  // A captain keeps a single open registration, so a second one has to belong to a
  // different actor.
  async function invoice(count = 1, actor = 'user') {
    const draft = await call('POST', '/orders/draft', undefined, actor);
    const id = draft.json().id;
    const selection = await call(
      'PATCH',
      `/orders/${id}/sports`,
      {
        company_name: 'Valley Strikers',
        sports: sports.slice(0, count).map((s) => ({
          sport_id: s.id,
        })),
      },
      actor,
    );
    if (selection.statusCode !== 200) throw new Error(selection.body);
    await call('POST', `/orders/${id}/phone`, { phone_number: '+977 9800000000' }, actor);
    const r = await call('POST', `/orders/${id}/invoice`, undefined, actor);
    if (r.statusCode !== 200) throw new Error(r.body);
    return r.json();
  }
  async function submit(count = 1, actor = 'user') {
    const o = await invoice(count, actor);
    const p = await call('POST', `/orders/${o.id}/payment-request`, undefined, actor);
    if (p.statusCode !== 200) throw new Error(p.body);
    const f = multipart('receipt');
    const r = await call('POST', `/orders/${o.id}/receipt`, f.payload, actor, f.headers);
    if (r.statusCode !== 200) throw new Error(r.body);
    return r.json();
  }
  async function confirm(count = 1) {
    const o = await submit(count);
    const r = await call(
      'POST',
      `/admin/orders/${o.id}/verify`,
      { decision: 'confirmed' },
      'staff',
    );
    if (r.statusCode !== 200) throw new Error(r.body);
    return r.json();
  }
  async function uploadPlayerPhotos(order: any, index = 0, count = 3) {
    const playerPhotos = [];
    for (let position = 0; position < count; position++) {
      const upload = multipart('photo');
      const photo = await call(
        'POST',
        `/orders/${order.id}/items/${order.items[index].id}/player-photos/${position}`,
        upload.payload,
        'user',
        upload.headers,
      );
      if (photo.statusCode !== 200) throw new Error(photo.body);
      playerPhotos.push(photo.json().photo_url);
    }
    return playerPhotos;
  }
  // A complete Cricksal squad needs seven players, so the profile edits below
  // produce a roster valid for every sport (Futsal needs five, Basketball three).
  const ROSTER = [
    'Suman Karki',
    'Pratik Gurung',
    'Aarav Shah',
    'Bibek Thapa',
    'Nabin Shrestha',
    'Kiran Basnet',
    'Ramesh Adhikari',
  ];
  const ROSTER_SIZES = ['S', 'M', 'XL', 'L', 'M', 'S', 'L'];
  async function fill(order: any, index = 0) {
    // A Cricksal roster carries a team sleeve choice, so the profile edits send one
    // whenever the item is a Cricksal registration.
    const cricksal = String(order.items[index].sport_name).toLowerCase() === 'cricksal';
    const f = multipart('logo', png, [
      { name: 'players', value: JSON.stringify(ROSTER) },
      ...(cricksal ? [{ name: 'jersey_style', value: JSON.stringify('full_sleeve') }] : []),
    ]);
    const r = await call(
      'PATCH',
      `/orders/${order.id}/items/${order.items[index].id}/profile`,
      f.payload,
      'user',
      f.headers,
    );
    if (r.statusCode !== 200) throw new Error(r.body);
    // The endpoint answers with the whole order; this helper hands back just the
    // profiled item, which is what the assertions in the tests read.
    const itemId = order.items[index].id;
    const saved = r.json().items.find((i: any) => i.id === itemId);
    const playerPhotos = await uploadPlayerPhotos(order, index, saved.players.length);
    const sized = await call('PATCH', `/orders/${order.id}/items/${itemId}/profile`, {
      players: ROSTER,
      jersey_sizes: ROSTER_SIZES,
      jersey_style: cricksal ? 'full_sleeve' : undefined,
      player_photos: playerPhotos,
    });
    if (sized.statusCode !== 200) throw new Error(sized.body);
    return sized.json().items.find((i: any) => i.id === itemId);
  }
  return {
    db,
    c,
    app,
    ...actors,
    sports,
    files,
    removed,
    sent,
    mailer,
    call,
    multipart,
    invoice,
    submit,
    confirm,
    fill,
    uploadPlayerPhotos,
    setIdentity: (i: typeof identity) => {
      identity = i;
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}
