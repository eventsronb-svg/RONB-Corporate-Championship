import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from './auth.js';
import { type Database, one } from './db.js';
import type { Config } from './config.js';
import type { Storage } from './providers.js';
import { assert } from './errors.js';
import {
  audit,
  detail,
  transition,
  queueEmail,
  uuid,
  ensureCapacity,
  reservedStates,
} from './orders.js';
const text = z.string().trim().min(1).max(2000);
const price = z
  .union([
    z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
    z
      .number()
      .finite()
      .min(0)
      .max(9999999999.99)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001),
  ])
  .transform(String);
const sportBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    price,
    description: z.string().max(5000).optional(),
    active: z.boolean().optional(),
    max_teams: z.number().int().positive().max(2147483647).nullable().optional(),
  })
  .strict();
const eventBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20000),
    start_date: z.string().datetime({ offset: true }),
    end_date: z.string().datetime({ offset: true }),
    venue: z.string().trim().min(1).max(500),
    show_teams: z.boolean().optional(),
  })
  .strict();
const listQuery = z.object({
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const idOf = (params: unknown) => z.object({ id: uuid }).parse(params).id;
export async function registerAdmin(
  app: FastifyInstance,
  db: Database,
  c: Config,
  storage: Storage,
) {
  const guard = auth(db, c);
  app.get('/admin/site-settings', { preHandler: guard.superAdmin }, async () => {
    const row = await one(db, "SELECT value FROM site_settings WHERE key='show_teams_section'");
    return { show_teams_section: row?.value !== false };
  });
  app.patch('/admin/site-settings', { preHandler: guard.superAdmin }, async (req) => {
    const value = z.object({ show_teams_section: z.boolean() }).parse(req.body).show_teams_section;
    await db.query(
      "INSERT INTO site_settings(key,value) VALUES('show_teams_section',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [value],
    );
    return { show_teams_section: value };
  });
  app.get('/admin/orders', { preHandler: guard.admin }, async (req) => {
    const q = listQuery
      .extend({
        status: z
          .enum([
            'all',
            'draft',
            'phone_captured',
            'invoiced',
            'payment_pending',
            'receipt_submitted',
            'under_review',
            'confirmed',
            'rejected',
            'contacted',
            'completed',
            'cancelled',
            'expired',
          ])
          .default('receipt_submitted'),
        sport_id: uuid.optional(),
        date_from: z.string().datetime({ offset: true }).optional(),
        date_to: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.query);
    const where: string[] = ['true'];
    const args: unknown[] = [];
    const add = (s: string, v: unknown) => {
      args.push(v);
      where.push(s.replaceAll('?', `$${args.length}`));
    };
    if (q.status === 'completed') where.push("o.status IN ('confirmed','contacted','completed')");
    else if (q.status !== 'all') add('o.status=?', q.status);
    if (q.search)
      add(
        '(u.name ILIKE ? OR u.email ILIKE ? OR o.id::text ILIKE ? OR EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.team_name ILIKE ?) OR EXISTS(SELECT 1 FROM payment_requests p WHERE p.order_id=o.id AND p.unique_code ILIKE ?))',
        `%${q.search}%`,
      );
    if (q.sport_id)
      add('EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.sport_id=?)', q.sport_id);
    if (q.date_from) add('o.created_at>=?', q.date_from);
    if (q.date_to) add('o.created_at<=?', q.date_to);
    const result = await db.query(
      `SELECT o.*,u.name AS captain_name,u.email,p.unique_code,
   (SELECT i.team_name FROM order_items i WHERE i.order_id=o.id ORDER BY i.id LIMIT 1) AS company_name,
   (SELECT max(uploaded_at) FROM receipts r WHERE r.order_id=o.id) AS receipt_submitted_at,
   coalesce((SELECT json_agg(json_build_object('id',i.id,'team_name',i.team_name,'sport_name',s.name,'profile_completed_at',i.profile_completed_at)) FROM order_items i JOIN sports s ON s.id=i.sport_id WHERE i.order_id=o.id),'[]') AS teams
   FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN payment_requests p ON p.order_id=o.id
   WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC,o.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.limit, q.offset],
    );
    return { orders: result.rows, limit: q.limit, offset: q.offset };
  });
  app.get('/admin/orders/:id', { preHandler: guard.admin }, async (req) => {
    const id = idOf(req.params);
    const order = await detail(db, id);
    const receipts = (
      await db.query('SELECT * FROM receipts WHERE order_id=$1 ORDER BY uploaded_at', [id])
    ).rows;
    return {
      ...order,
      user: await one(db, 'SELECT id,email,name,phone FROM users WHERE id=$1', [order.user_id]),
      receipts: await Promise.all(
        receipts.map(async (r) => ({
          id: r.id,
          uploaded_at: r.uploaded_at,
          signed_url: await storage.signReceipt(r.file_url),
          expires_in: 300,
        })),
      ),
      timeline: (
        await db.query(
          'SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY changed_at,id',
          [id],
        )
      ).rows,
      verifications: (
        await db.query(
          'SELECT * FROM payment_verifications WHERE order_id=$1 ORDER BY verified_at',
          [id],
        )
      ).rows,
      email_log: (
        await db.query('SELECT * FROM email_log WHERE order_id=$1 ORDER BY created_at', [id])
      ).rows,
      email_jobs: (
        await db.query(
          'SELECT id,kind,status,attempts,last_error,created_at FROM email_jobs WHERE order_id=$1 ORDER BY created_at',
          [id],
        )
      ).rows,
      audit_log: (
        await db.query(
          "SELECT id,admin_id,action,metadata,created_at FROM audit_logs WHERE entity_type='order' AND entity_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows,
    };
  });
  for (const action of [
    'review',
    'verify',
    'contact',
    'complete',
    'cancel',
    'resend-email',
  ] as const) {
    app.post(
      `/admin/orders/:id/${action}`,
      { preHandler: action === 'cancel' ? guard.superAdmin : guard.admin },
      async (req) => {
        const id = idOf(req.params);
        const body =
          action === 'verify'
            ? z
                .object({
                  decision: z.enum(['confirmed', 'rejected']),
                  notes: z.string().trim().max(2000).default(''),
                })
                .strict()
                .parse(req.body)
            : action === 'cancel'
              ? z.object({ reason: text }).strict().parse(req.body)
              : action === 'contact'
                ? z
                    .object({ notes: z.string().trim().max(2000).default('') })
                    .strict()
                    .parse(req.body ?? {})
                : {};
        return db.transaction(async (tx) => {
          const o = await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
          assert(o, 404, 'not_found', 'Order not found');
          const adminId = req.actor!.id;
          if (action === 'verify') {
            const { decision, notes } = body as { decision: string; notes: string };
            assert(
              ['receipt_submitted', 'under_review'].includes(o.status),
              409,
              'invalid_state',
              'Only submitted receipts can be verified',
            );
            assert(
              decision !== 'rejected' || notes.length > 0,
              400,
              'notes_required',
              'Explain why the payment was rejected',
            );
            assert(
              await one(tx, 'SELECT id FROM receipts WHERE order_id=$1 LIMIT 1', [id]),
              409,
              'no_receipt',
              'A receipt is required',
            );
            if (decision === 'confirmed') await ensureCapacity(tx, id);
            await tx.query(
              'INSERT INTO payment_verifications(order_id,admin_id,decision,notes) VALUES($1,$2,$3,$4)',
              [id, adminId, decision, notes],
            );
            await transition(
              tx,
              o,
              decision,
              adminId,
              decision === 'rejected' ? 'admin_rejected' : null,
            );
          } else if (action === 'review') {
            assert(
              o.status === 'receipt_submitted',
              409,
              'invalid_state',
              'Only submitted orders can enter review',
            );
            await transition(tx, o, 'under_review', adminId);
          } else if (action === 'contact') {
            assert(
              o.status === 'confirmed',
              409,
              'invalid_state',
              'Only confirmed orders can be marked contacted',
            );
            await transition(tx, o, 'contacted', adminId);
          } else if (action === 'complete') {
            assert(
              o.status === 'contacted',
              409,
              'invalid_state',
              'Mark the order contacted before completing it',
            );
            await transition(tx, o, 'completed', adminId);
          } else if (action === 'cancel') {
            assert(o.status !== 'cancelled', 409, 'invalid_state', 'Order is already cancelled');
            await transition(tx, o, 'cancelled', adminId, 'admin_rejected');
          } else {
            const recent = await one(
              tx,
              "SELECT id FROM email_jobs WHERE order_id=$1 AND kind='manual' AND created_at>now()-interval '1 minute'",
              [id],
            );
            assert(
              !recent,
              429,
              'resend_throttled',
              'Wait one minute before requesting another resend',
            );
            await queueEmail(tx, id, 'manual', {
              appOrigin: c.APP_ORIGIN,
              fromAddress: c.EMAIL_FROM,
            });
          }
          await audit(tx, adminId, `order.${action}`, 'order', id, body);
          return detail(tx, id);
        });
      },
    );
  }
  app.get(
    '/admin/sports',
    { preHandler: guard.superAdmin },
    async () => (await db.query('SELECT * FROM sports ORDER BY name')).rows,
  );
  app.post('/admin/sports', { preHandler: guard.superAdmin }, async (req, reply) => {
    const b = sportBody.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const s = (await one(
        tx,
        'INSERT INTO sports(name,price,description,active,max_teams) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [b.name, b.price, b.description ?? '', b.active ?? true, b.max_teams ?? null],
      ))!;
      await audit(tx, req.actor!.id, 'sport.create', 'sport', s.id, b);
      return s;
    });
    return reply.code(201).send(result);
  });
  for (const method of ['PATCH', 'DELETE'] as const)
    app.route({
      method,
      url: '/admin/sports/:id',
      preHandler: guard.superAdmin,
      handler: async (req) => {
        const id = idOf(req.params);
        const b =
          method === 'DELETE'
            ? { active: false }
            : sportBody
                .partial()
                .refine((b) => Object.keys(b).length > 0, 'Provide at least one change')
                .parse(req.body);
        return db.transaction(async (tx) => {
          const before = await one(tx, 'SELECT * FROM sports WHERE id=$1 FOR UPDATE', [id]);
          assert(before, 404, 'not_found', 'Sport not found');
          const merged = { ...before, ...b };
          if (merged.max_teams != null) {
            const used = await one(
              tx,
              'SELECT count(*)::int AS count FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sport_id=$1 AND o.status=ANY($2::text[])',
              [id, reservedStates],
            );
            assert(
              merged.max_teams >= used!.count,
              409,
              'capacity_in_use',
              'Capacity cannot be lower than the number of reserved slots',
            );
          }
          const after = await one(
            tx,
            'UPDATE sports SET name=$2,price=$3,description=$4,active=$5,max_teams=$6 WHERE id=$1 RETURNING *',
            [id, merged.name, merged.price, merged.description, merged.active, merged.max_teams],
          );
          await audit(
            tx,
            req.actor!.id,
            method === 'DELETE' ? 'sport.deactivate' : 'sport.update',
            'sport',
            id,
            { before, after },
          );
          return after;
        });
      },
    });
  app.get(
    '/admin/event',
    { preHandler: guard.superAdmin },
    async () => (await one(db, 'SELECT * FROM events WHERE active')) ?? null,
  );
  app.patch('/admin/event', { preHandler: guard.superAdmin }, async (req) => {
    const b = eventBody
      .partial()
      .refine((b) => Object.keys(b).length > 0, 'Provide at least one change')
      .parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(427191)');
      const before = await one(tx, 'SELECT * FROM events WHERE active FOR UPDATE');
      if (Object.keys(b).length === 1 && b.show_teams !== undefined) {
        assert(before, 404, 'not_found', 'Event not found');
        return one(
          tx,
          'UPDATE events SET show_teams=$1,updated_at=now() WHERE id=$2 RETURNING *',
          [b.show_teams, before.id],
        );
      }
      const existing = before
        ? {
            title: before.title,
            description: before.description,
            start_date: new Date(before.start_date).toISOString(),
            end_date: new Date(before.end_date).toISOString(),
            venue: before.venue,
            show_teams: before.show_teams,
          }
        : {};
      const merged = eventBody.parse({ ...existing, ...b });
      assert(
        new Date(merged.end_date) >= new Date(merged.start_date),
        400,
        'invalid_dates',
        'End date must be after start date',
      );
      const values = [
        merged.title,
        merged.description,
        merged.start_date,
        merged.end_date,
        merged.venue,
        merged.show_teams ?? true,
      ];
      const after = before
        ? await one(
            tx,
            'UPDATE events SET title=$1,description=$2,start_date=$3,end_date=$4,venue=$5,show_teams=$6,updated_at=now() WHERE id=$7 RETURNING *',
            [...values, before.id],
          )
        : await one(
            tx,
            'INSERT INTO events(title,description,start_date,end_date,venue,show_teams) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            values,
          );
      await audit(tx, req.actor!.id, 'event.update', 'event', after!.id, {
        before: before ?? null,
        after,
      });
      return after;
    });
  });
  app.get('/admin/teams', { preHandler: guard.admin }, async (req) => {
    const q = listQuery.parse(req.query);
    return {
      teams: (
        await db.query(
          `SELECT o.id,o.status,o.created_at,u.name AS captain_name,u.email,
           coalesce(o.phone_number,u.phone) AS phone,
           (SELECT i.team_name FROM order_items i WHERE i.order_id=o.id ORDER BY i.id LIMIT 1) AS team_name,
           ARRAY(SELECT s.name FROM order_items i JOIN sports s ON s.id=i.sport_id WHERE i.order_id=o.id ORDER BY s.name) AS sports
           FROM orders o JOIN users u ON u.id=o.user_id
           WHERE EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id)
           AND ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1 OR coalesce(o.phone_number,u.phone) ILIKE $1
             OR EXISTS(SELECT 1 FROM order_items i JOIN sports s ON s.id=i.sport_id WHERE i.order_id=o.id AND (i.team_name ILIKE $1 OR s.name ILIKE $1)))
           ORDER BY o.created_at DESC,o.id LIMIT $2 OFFSET $3`,
          [q.search ? `%${q.search}%` : null, q.limit, q.offset],
        )
      ).rows,
      limit: q.limit,
      offset: q.offset,
    };
  });
  app.get('/admin/teams/:id', { preHandler: guard.admin }, async (req) => {
    const order = await detail(db, idOf(req.params));
    assert(order.items.length, 404, 'not_found', 'Team not found');
    return {
      id: order.id,
      team_name: order.company_name || order.items[0].team_name,
      status: order.status,
      created_at: order.created_at,
      phone: order.phone_number,
      contact: await one(db, 'SELECT name,email,phone FROM users WHERE id=$1', [order.user_id]),
      items: order.items,
    };
  });
  app.get('/admin/users', { preHandler: guard.admin }, async (req) => {
    const q = listQuery.parse(req.query);
    return {
      users: (
        await db.query(
          `SELECT u.id,u.email,u.name,u.phone,u.created_at,
   coalesce(k.companies,'[]') AS companies
   FROM users u
   LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('company',c.team_name,'sports',c.sports) ORDER BY c.team_name) AS companies
    FROM (
     SELECT i.team_name, array_agg(DISTINCT s.name ORDER BY s.name) AS sports
     FROM order_items i JOIN orders o ON o.id=i.order_id JOIN sports s ON s.id=i.sport_id
     WHERE o.user_id=u.id GROUP BY i.team_name
    ) c
   ) k ON true
   WHERE ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1)
   ORDER BY u.created_at DESC,u.id LIMIT $2 OFFSET $3`,
          [q.search ? `%${q.search}%` : null, q.limit, q.offset],
        )
      ).rows,
      limit: q.limit,
      offset: q.offset,
    };
  });
  app.get('/admin/users/:id', { preHandler: guard.admin }, async (req) => {
    const id = idOf(req.params);
    const user = await one(db, 'SELECT id,email,name,phone,created_at FROM users WHERE id=$1', [
      id,
    ]);
    assert(user, 404, 'not_found', 'User not found');
    return {
      ...user,
      orders: (
        await db.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [id])
      ).rows,
    };
  });
  app.get(
    '/admin/admins',
    { preHandler: guard.superAdmin },
    async () =>
      (
        await db.query(
          'SELECT id,email,name,role,active,created_at FROM admins ORDER BY created_at',
        )
      ).rows,
  );
  app.post('/admin/admins', { preHandler: guard.superAdmin }, async (req, reply) => {
    const b = z
      .object({
        email: z
          .string()
          .email()
          .transform((s) => s.toLowerCase()),
        role: z.enum(['staff', 'super_admin']).default('staff'),
      })
      .strict()
      .parse(req.body);
    const result = await db.transaction(async (tx) => {
      const a = (await one(
        tx,
        'INSERT INTO admins(email,role) VALUES($1,$2) RETURNING id,email,name,role,active,created_at',
        [b.email, b.role],
      ))!;
      await audit(tx, req.actor!.id, 'admin.invite', 'admin', a.id, b);
      return a;
    });
    return reply.code(201).send(result);
  });
  app.patch('/admin/admins/:id', { preHandler: guard.superAdmin }, async (req) => {
    const id = idOf(req.params);
    const b = z
      .object({ role: z.enum(['staff', 'super_admin']).optional(), active: z.boolean().optional() })
      .strict()
      .refine((b) => Object.keys(b).length > 0)
      .parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(427192)');
      const before = await one(tx, 'SELECT * FROM admins WHERE id=$1 FOR UPDATE', [id]);
      assert(before, 404, 'not_found', 'Admin not found');
      const m = { ...before, ...b };
      if (
        before.active &&
        before.role === 'super_admin' &&
        (!m.active || m.role !== 'super_admin')
      ) {
        const other = await one(
          tx,
          "SELECT id FROM admins WHERE active AND role='super_admin' AND id<>$1 LIMIT 1",
          [id],
        );
        assert(other, 409, 'last_super_admin', 'At least one active super admin must remain');
      }
      const after = await one(
        tx,
        'UPDATE admins SET role=$2,active=$3 WHERE id=$1 RETURNING id,email,name,role,active,created_at',
        [id, m.role, m.active],
      );
      if (!m.active) await tx.query('DELETE FROM sessions WHERE admin_id=$1', [id]);
      await audit(tx, req.actor!.id, 'admin.update', 'admin', id, { before, after });
      return after;
    });
  });
}
