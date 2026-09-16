import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { type Database, one, type Row } from './db.js';
import type { GoogleProvider } from './providers.js';
import { assert } from './errors.js';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export type Actor = { id: string; kind: 'user' | 'admin'; role?: string };
declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}
export function auth(db: Database, c: Config) {
  async function resolve(req: FastifyRequest, kind: 'user' | 'admin') {
    const raw = req.cookies[kind === 'admin' ? 'admin_session' : 'session'];
    assert(raw, 401, 'unauthenticated', 'Sign in to continue');
    const session = await one(
      db,
      `SELECT s.*, a.role, a.active FROM sessions s LEFT JOIN admins a ON a.id=s.admin_id WHERE token_hash=$1 AND expires_at>now()`,
      [hash(raw)],
    );
    const id = session?.[`${kind}_id`];
    assert(
      id && (kind !== 'admin' || session?.active),
      401,
      'unauthenticated',
      'Session expired or account inactive',
    );
    req.actor = { id, kind, role: session?.role };
  }
  return {
    user: async (req: FastifyRequest) => resolve(req, 'user'),
    admin: async (req: FastifyRequest) => resolve(req, 'admin'),
    superAdmin: async (req: FastifyRequest) => {
      await resolve(req, 'admin');
      assert(req.actor?.role === 'super_admin', 403, 'forbidden', 'Super admin access is required');
    },
  };
}
export async function registerAuth(
  app: FastifyInstance,
  db: Database,
  c: Config,
  google: GoogleProvider,
) {
  const guard = auth(db, c);
  const cookieOptions = {
    httpOnly: true,
    secure: c.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
  app.post(
    '/admin/auth/password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      assert(
        c.ADMIN_LOGIN_USERNAME && c.ADMIN_LOGIN_PASSWORD,
        503,
        'password_login_disabled',
        'Password sign-in is not configured. Use Google sign-in.',
      );
      const input = z
        .object({ username: z.string().min(1).max(200), password: z.string().min(1).max(200) })
        .strict()
        .parse(req.body);
      const valid =
        timingSafeEqual(
          Buffer.from(hash(input.username)),
          Buffer.from(hash(c.ADMIN_LOGIN_USERNAME)),
        ) &&
        timingSafeEqual(
          Buffer.from(hash(input.password)),
          Buffer.from(hash(c.ADMIN_LOGIN_PASSWORD)),
        );
      assert(valid, 401, 'invalid_credentials', 'Username or password is incorrect');
      const token = randomBytes(32).toString('base64url');
      const admin = await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO admins(email,name,role,active) VALUES('password-admin@ronb.local','Password administrator','super_admin',true)
           ON CONFLICT(email) DO NOTHING`,
        );
        const person = await one(
          tx,
          "SELECT * FROM admins WHERE email='password-admin@ronb.local' FOR UPDATE",
        );
        assert(person?.active, 403, 'account_inactive', 'This organizer account is inactive');
        const oldToken = req.cookies.admin_session;
        if (oldToken) await tx.query('DELETE FROM sessions WHERE token_hash=$1', [hash(oldToken)]);
        await tx.query(
          "INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
          [hash(token), person!.id],
        );
        await tx.query(
          "INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,'auth.password_login','admin',$1,'{}')",
          [person!.id],
        );
        return person!;
      });
      reply.setCookie('admin_session', token, { ...cookieOptions, maxAge: 604800 });
      return { admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } };
    },
  );
  for (const kind of ['user', 'admin'] as const) {
    const prefix = kind === 'admin' ? '/admin/auth' : '/auth';
    const stateCookie = `${kind}_oauth_state`;
    const sessionCookie = kind === 'admin' ? 'admin_session' : 'session';
    const redirectUri = `${c.APP_ORIGIN}${prefix}/google/callback`;
    app.get(
      `${prefix}/google`,
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (_req, reply) => {
        const state = randomBytes(32).toString('base64url');
        const verifier = randomBytes(48).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const url = google.authorizationUrl(redirectUri, state, challenge);
        await db.query(
          "INSERT INTO oauth_states(state_hash,verifier,audience,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
          [hash(state), verifier, kind],
        );
        reply.setCookie(stateCookie, state, { ...cookieOptions, signed: true, maxAge: 600 });
        return reply.redirect(url);
      },
    );
    const callback = async (req: FastifyRequest, reply: FastifyReply) => {
      const input = z
        .object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(256) })
        .parse(req.method === 'GET' ? req.query : req.body);
      const signed = req.cookies[stateCookie];
      const unsigned = signed ? req.unsignCookie(signed) : null;
      assert(
        unsigned?.valid && unsigned.value === input.state,
        401,
        'invalid_state',
        'Sign-in state is invalid; start sign-in again',
      );
      const state = await one(
        db,
        'DELETE FROM oauth_states WHERE state_hash=$1 AND audience=$2 AND expires_at>now() RETURNING verifier',
        [hash(input.state), kind],
      );
      assert(state, 401, 'invalid_state', 'Sign-in state expired or already used');
      reply.clearCookie(stateCookie, cookieOptions);
      const identity = await google.exchange(input.code, redirectUri, state.verifier);
      const token = randomBytes(32).toString('base64url');
      const result = await db.transaction(async (tx) => {
        let person: Row | undefined;
        if (kind === 'user') {
          person = await one(
            tx,
            `INSERT INTO users(google_id,email,name) VALUES($1,$2,$3)
      ON CONFLICT(google_id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name RETURNING *`,
            [identity.googleId, identity.email.toLowerCase(), identity.name],
          );
        } else {
          person = await one(tx, 'SELECT * FROM admins WHERE email=$1 AND active FOR UPDATE', [
            identity.email.toLowerCase(),
          ]);
          assert(
            person && (!person.google_id || person.google_id === identity.googleId),
            403,
            'not_admin',
            'This Google account is not on the admin allowlist',
          );
          await tx.query('UPDATE admins SET google_id=$1,name=$2 WHERE id=$3', [
            identity.googleId,
            identity.name,
            person.id,
          ]);
          await tx.query(
            "INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,'auth.login','admin',$1,'{}')",
            [person.id],
          );
        }
        const oldToken = req.cookies[sessionCookie];
        if (oldToken) await tx.query('DELETE FROM sessions WHERE token_hash=$1', [hash(oldToken)]);
        await tx.query(
          `INSERT INTO sessions(token_hash,${kind}_id,expires_at) VALUES($1,$2,now()+interval '7 days')`,
          [hash(token), person!.id],
        );
        return {
          id: person!.id,
          email: identity.email,
          name: identity.name,
          ...(kind === 'admin' ? { role: person!.role } : {}),
        };
      });
      reply.setCookie(sessionCookie, token, { ...cookieOptions, maxAge: 604800 });
      if (req.method === 'GET') return reply.redirect(kind === 'admin' ? '/admin' : '/register');
      return { [kind]: result };
    };
    app.get(`${prefix}/google/callback`, callback);
    app.post(`${prefix}/google/callback`, callback);
    app.post(`${prefix}/logout`, { preHandler: guard[kind] }, async (req, reply) => {
      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM sessions WHERE token_hash=$1', [
          hash(req.cookies[sessionCookie]!),
        ]);
        if (kind === 'admin')
          await tx.query(
            "INSERT INTO audit_logs(admin_id,action,entity_type,entity_id) VALUES($1,'auth.logout','admin',$1)",
            [req.actor!.id],
          );
      });
      reply.clearCookie(sessionCookie, cookieOptions);
      return { ok: true };
    });
  }
  app.get('/auth/me', { preHandler: guard.user }, (req) =>
    one(db, 'SELECT id,email,name,phone FROM users WHERE id=$1', [req.actor!.id]),
  );
  app.get('/admin/me', { preHandler: guard.admin }, (req) =>
    one(db, 'SELECT id,email,name,role FROM admins WHERE id=$1', [req.actor!.id]),
  );
}
