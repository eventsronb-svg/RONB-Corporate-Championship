import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z, ZodError } from 'zod';
import { type Database, one, postgres } from './db.js';
import { type Config, config } from './config.js';
import {
  type GoogleProvider,
  type Storage,
  googleProvider,
  s3Storage,
  validateFile,
} from './providers.js';
import { auth, registerAuth } from './auth.js';
import { Orders, teamSelection, profileInput, uuid, detail, paid } from './orders.js';
import { registerAdmin } from './admin.js';
import { assert, HttpError } from './errors.js';
export async function buildApp(deps: {
  db: Database;
  config: Config;
  google: GoogleProvider;
  storage: Storage;
  logger?: boolean;
}) {
  const { db, config: c, google, storage } = deps;
  const app = Fastify({
    logger: deps.logger
      ? {
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
          serializers: {
            req: (req) => ({
              method: req.method,
              url: req.url.split('?')[0],
              hostname: req.hostname,
              remoteAddress: req.ip,
            }),
          },
        }
      : false,
    bodyLimit: 6 * 1024 * 1024,
    requestTimeout: 30000,
  });
  await app.register(cookie, { secret: c.COOKIE_SECRET });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        frameSrc: ['https:'],
        formAction: ["'self'"],
        upgradeInsecureRequests: c.NODE_ENV === 'production' ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2, fieldSize: 20000 },
  });
  app.decorateRequest('actor', undefined);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // Browser mutations must be same-origin, including multipart uploads and login callbacks.
      assert(
        req.headers.origin === c.APP_ORIGIN,
        403,
        'invalid_origin',
        'Mutating requests require the configured Origin header',
      );
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Invalid request',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    if (error instanceof HttpError)
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    const e = error as { code?: string; statusCode?: number; message?: string };
    if (e.code === '23505')
      return reply.code(409).send({
        error: 'conflict',
        message: 'This record conflicts with an existing registration or unique value',
      });
    if (e.code === '23514' || e.code === '23503')
      return reply.code(409).send({
        error: 'constraint_violation',
        message: 'This change violates a registration constraint',
      });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)
      return reply
        .code(e.statusCode)
        .send({ error: e.code ?? 'invalid_request', message: e.message });
    req.log.error({ err: error }, 'Request failed');
    return reply
      .code(500)
      .send({ error: 'internal_error', message: 'The request could not be completed' });
  });
  await registerAuth(app, db, c, google);
  const guard = auth(db, c);
  const orders = new Orders(db, c);
  const id = (p: unknown) => z.object({ id: uuid }).parse(p).id;
  const itemIds = (p: unknown) => z.object({ id: uuid, item_id: uuid }).parse(p);
  async function readOwned(userId: string, orderId: string) {
    assert(
      await one(db, 'SELECT id FROM orders WHERE id=$1 AND user_id=$2', [orderId, userId]),
      404,
      'not_found',
      'Order not found',
    );
    return detail(db, orderId);
  }
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/event', async () => (await one(db, 'SELECT * FROM events WHERE active')) ?? null);
  app.get(
    '/sports',
    async () => (await db.query('SELECT * FROM sports WHERE active ORDER BY name')).rows,
  );
  app.get('/teams', async (req) => {
    const q = z
      .object({
        sport_id: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    return (
      await db.query(
        `SELECT i.id,i.team_name,i.logo_url,i.sport_id,s.name AS sport_name,
   coalesce((SELECT json_agg(p.player_name ORDER BY p.position,p.created_at,p.id) FROM team_players p WHERE p.order_item_id=i.id),'[]') AS players
   FROM order_items i JOIN orders o ON o.id=i.order_id JOIN sports s ON s.id=i.sport_id
   WHERE o.status IN ('confirmed','contacted','completed') AND i.profile_completed_at IS NOT NULL
   AND ($1::uuid IS NULL OR i.sport_id=$1) ORDER BY s.name,i.team_name,i.id LIMIT $2 OFFSET $3`,
        [q.sport_id ?? null, q.limit, q.offset],
      )
    ).rows;
  });
  app.get('/orders/current', { preHandler: guard.user }, (req) => orders.current(req.actor!.id));
  app.post('/orders/draft', { preHandler: guard.user }, (req) => orders.draft(req.actor!.id));
  app.patch('/orders/:id/sports', { preHandler: guard.user }, (req) =>
    orders.sports(req.actor!.id, id(req.params), teamSelection.parse(req.body)),
  );
  app.post('/orders/:id/phone', { preHandler: guard.user }, (req) => {
    const b = z
      .object({
        phone_number: z
          .string()
          .trim()
          .regex(/^\+?[0-9][0-9 ()-]{6,23}$/)
          .refine(
            (s) => s.replace(/\D/g, '').length >= 7 && s.replace(/\D/g, '').length <= 15,
            'Use a phone number with 7–15 digits',
          ),
      })
      .strict()
      .parse(req.body);
    return orders.phone(req.actor!.id, id(req.params), b.phone_number);
  });
  app.post('/orders/:id/invoice', { preHandler: guard.user }, (req) =>
    orders.invoice(req.actor!.id, id(req.params)),
  );
  app.post('/orders/:id/payment-request', { preHandler: guard.user }, (req) =>
    orders.payment(req.actor!.id, id(req.params)),
  );
  app.get('/orders/:id/status', { preHandler: guard.user }, (req) =>
    readOwned(req.actor!.id, id(req.params)),
  );
  app.post('/orders/:id/cancel-and-revise', { preHandler: guard.user }, (req) =>
    orders.revise(req.actor!.id, id(req.params)),
  );
  app.post('/orders/:id/receipt', { preHandler: guard.user }, async (req) => {
    const orderId = id(req.params);
    const order = await readOwned(req.actor!.id, orderId);
    assert(
      ['payment_pending', 'receipt_submitted', 'rejected'].includes(order.status),
      409,
      'invalid_state',
      'This order is not accepting receipts',
    );
    let upload: { buffer: Buffer; mime: string } | undefined;
    assert(
      req.isMultipart(),
      415,
      'multipart_required',
      'Send a multipart file field named receipt',
    );
    for await (const part of req.parts()) {
      assert(
        part.type === 'file' && part.fieldname === 'receipt',
        400,
        'invalid_field',
        'Send one receipt file',
      );
      upload = await validateFile(await part.toBuffer(), part.mimetype, 'receipt');
    }
    assert(upload, 400, 'file_required', 'A receipt file is required');
    const stored = await storage.put('receipt', upload.buffer, upload.mime);
    try {
      return await orders.receipt(req.actor!.id, orderId, stored.key);
    } catch (e) {
      await storage
        .remove('receipt', stored.key)
        .catch((err) => req.log.error({ err }, 'Upload cleanup failed'));
      throw e;
    }
  });
  app.get('/orders/:id/items/:item_id/profile', { preHandler: guard.user }, async (req) => {
    const p = itemIds(req.params);
    const order = await readOwned(req.actor!.id, p.id);
    assert(
      paid.includes(order.status),
      409,
      'payment_unconfirmed',
      'Team profiles unlock after confirmation',
    );
    const item = order.items.find((i) => i.id === p.item_id);
    assert(item, 404, 'not_found', 'Team not found');
    return item;
  });
  app.patch('/orders/:id/items/:item_id/profile', { preHandler: guard.user }, async (req) => {
    const p = itemIds(req.params);
    const order = await readOwned(req.actor!.id, p.id);
    assert(
      paid.includes(order.status),
      409,
      'payment_unconfirmed',
      'Team profiles unlock after confirmation',
    );
    assert(
      order.items.some((i) => i.id === p.item_id),
      404,
      'not_found',
      'Team not found',
    );
    let input: z.infer<typeof profileInput> = {};
    let upload: { buffer: Buffer; mime: string } | undefined;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          assert(
            part.fieldname === 'logo',
            400,
            'invalid_field',
            'The file field must be named logo',
          );
          upload = await validateFile(await part.toBuffer(), part.mimetype, 'logo');
        } else {
          assert(
            part.fieldname === 'players',
            400,
            'invalid_field',
            'Only players and logo fields are accepted',
          );
          let value: unknown;
          try {
            value = JSON.parse(String(part.value));
          } catch {
            throw new HttpError(400, 'invalid_players', 'Players must be a JSON array of names');
          }
          input = profileInput.parse({ players: value });
        }
      }
    } else input = profileInput.parse(req.body);
    const stored = upload ? await storage.put('logo', upload.buffer, upload.mime) : undefined;
    try {
      return await orders.profile(req.actor!.id, p.id, p.item_id, {
        ...input,
        ...(stored ? { logo_url: stored.url } : {}),
      });
    } catch (e) {
      if (stored)
        await storage
          .remove('logo', stored.key)
          .catch((err) => req.log.error({ err }, 'Upload cleanup failed'));
      throw e;
    }
  });
  app.post('/orders/:id/items/:item_id/profile/complete', { preHandler: guard.user }, (req) => {
    const p = itemIds(req.params);
    return orders.profile(req.actor!.id, p.id, p.item_id, {}, true);
  });
  await registerAdmin(app, db, c, storage);
  await app.register(staticPlugin, { root: resolve('public'), prefix: '/assets/' });
  app.get('/admin', async (_req, reply) => reply.sendFile('admin.html'));
  app.get('/', async (_req, reply) => reply.sendFile('index.html'));
  app.get('/register', async (_req, reply) => reply.sendFile('index.html'));
  return app;
}

type HttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT';
type ServerApp = Awaited<ReturnType<typeof buildApp>>;

let serverApp: ServerApp | undefined;

const publicRoot = resolve('public');
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function staticPath(pathname: string): string | undefined {
  let relativePath: string;
  if (pathname === '/' || pathname === '/register') {
    relativePath = 'index.html';
  } else if (pathname.startsWith('/assets/')) {
    relativePath = pathname.slice('/assets/'.length);
  } else {
    relativePath = pathname.slice(1);
  }
  if (!relativePath || relativePath.includes('\0')) return undefined;
  const candidate = resolve(
    publicRoot,
    relativePath === 'favicon.ico' ? 'favicon.svg' : relativePath,
  );
  const route = relative(publicRoot, candidate);
  if (route.startsWith('..') || route.includes(`..${sep}`) || !existsSync(candidate))
    return undefined;
  return candidate;
}

async function servePublicFile(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) return false;
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const file = staticPath(pathname);
  if (!file) return false;
  const extension = file.slice(file.lastIndexOf('.'));
  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypes[extension] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Cache-Control',
    extension === '.html'
      ? 'public, max-age=0, must-revalidate'
      : 'public, max-age=31536000, immutable',
  );
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(await readFile(file));
  }
  return true;
}

async function getServerApp(): Promise<ServerApp> {
  if (!serverApp) {
    const c = config();
    serverApp = await buildApp({
      db: postgres(c.DATABASE_URL),
      config: c,
      google: googleProvider(c),
      storage: s3Storage(c),
      logger: true,
    });
  }
  return serverApp;
}

export default async function vercelHandler(req: IncomingMessage, res: ServerResponse) {
  try {
    // The public event site must remain available when Vercel has not yet been
    // configured with database and provider credentials. Dynamic routes start
    // Fastify below and therefore retain their existing configuration checks.
    if (await servePublicFile(req, res)) return;
    const app = await getServerApp();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        !value ||
        ['connection', 'content-length', 'expect', 'host', 'transfer-encoding'].includes(name)
      )
        continue;
      headers[name] = typeof value === 'string' ? value : value.join(', ');
    }
    const result = await app.inject({
      method: (req.method ?? 'GET').toUpperCase() as HttpMethod,
      url: url.pathname + url.search,
      headers,
      ...(payload.length > 0 ? { payload } : {}),
    });
    res.statusCode = result.statusCode;
    for (const [name, value] of Object.entries(result.headers)) {
      if (value !== undefined) res.setHeader(name, value);
    }
    res.end(result.rawPayload);
  } catch (error) {
    console.error('Vercel request failed', error);
    if (!res.headersSent) {
      // Do not leak configuration or provider details to the browser. Returning
      // JSON also lets the public registration page present a useful message
      // instead of failing while it tries to parse Vercel's plain-text error.
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          error: 'service_unavailable',
          message: 'Registration is temporarily unavailable. Please try again shortly.',
        }),
      );
    }
  }
}
