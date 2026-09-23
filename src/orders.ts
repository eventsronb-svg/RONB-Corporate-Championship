import { z } from 'zod';
import { type Database, type Queryable, type Row, one } from './db.js';
import { PAYMENT_BANK_DETAILS, PAYMENT_INSTRUCTIONS, type Config } from './config.js';
import { assert } from './errors.js';
import { confirmationEmail } from './email-templates.js';
export const paid = ['confirmed', 'contacted', 'completed'];
export const openSql = "status NOT IN ('completed','cancelled','expired','rejected')";
// Minimum roster size required to complete a team profile, keyed by sport slug/name.
export const MIN_ROSTER: Record<string, number> = { cricksal: 7, basketball: 3, futsal: 5 };
export const reservedStates = [
  'invoiced',
  'payment_pending',
  'receipt_submitted',
  'under_review',
  ...paid,
];
// A slot is reserved at invoicing; all contenders lock sport rows in the same order.
export async function ensureCapacity(tx: Queryable, orderId: string) {
  const sports = (
    await tx.query(
      'SELECT * FROM sports WHERE id IN (SELECT sport_id FROM order_items WHERE order_id=$1) ORDER BY id FOR UPDATE',
      [orderId],
    )
  ).rows;
  for (const sport of sports) {
    if (sport.max_teams === null) continue;
    const used = await one(
      tx,
      'SELECT count(*)::int AS count FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sport_id=$1 AND o.id<>$2 AND o.status=ANY($3::text[])',
      [sport.id, orderId, reservedStates],
    );
    assert(
      used!.count < sport.max_teams,
      409,
      'sport_full',
      `${sport.name} has no registration slots remaining. Contact the organizer or choose another sport.`,
    );
  }
}
export const uuid = z.string().uuid();
export const teamSelection = z
  .object({
    company_name: z.string().trim().min(1).max(120),
    sports: z.array(z.object({ sport_id: uuid }).strict()).length(1),
  })
  .strict();
export const profileInput = z
  .object({
    players: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    jersey_sizes: z
      .array(z.enum(['S', 'M', 'L', 'XL']).nullable())
      .max(100)
      .optional(),
    jersey_style: z.enum(['full_sleeve', 'half_sleeve']).nullable().optional(),
    jersey_styles: z.array(z.enum(['full_sleeve', 'half_sleeve']).nullable()).max(100).optional(),
    captain_position: z.number().int().min(0).max(99).nullable().optional(),
    player_photos: z.array(z.string().startsWith('player-photos/').nullable()).max(100).optional(),
  })
  .strict();
export async function transition(
  tx: Queryable,
  order: Row,
  to: string,
  adminId: string | null = null,
  reason: string | null = null,
) {
  await tx.query(
    "UPDATE orders SET status=$2,updated_at=now(),cancellation_reason=$3,confirmed_at=CASE WHEN $2='confirmed' THEN coalesce(confirmed_at,now()) ELSE confirmed_at END WHERE id=$1",
    [order.id, to, reason],
  );
  await tx.query(
    'INSERT INTO order_status_history(order_id,from_status,to_status,changed_by) VALUES($1,$2,$3,$4)',
    [order.id, order.status, to, adminId],
  );
}
export async function detail(tx: Queryable, id: string): Promise<Row & { items: Row[] }> {
  const order = await one(tx, 'SELECT * FROM orders WHERE id=$1', [id]);
  assert(order, 404, 'not_found', 'Order not found');
  const items = (
    await tx.query(
      `SELECT i.*,s.name AS sport_name,coalesce((SELECT json_agg(p.player_name ORDER BY p.position,p.created_at,p.id) FROM team_players p WHERE p.order_item_id=i.id),'[]') AS players,
 coalesce((SELECT json_agg(p.jersey_size ORDER BY p.position,p.created_at,p.id) FROM team_players p WHERE p.order_item_id=i.id),'[]') AS jersey_sizes,
 i.jersey_style,
 coalesce((SELECT json_agg(p.photo_url ORDER BY p.position,p.created_at,p.id) FROM team_players p WHERE p.order_item_id=i.id),'[]') AS photo_urls
 FROM order_items i JOIN sports s ON s.id=i.sport_id WHERE i.order_id=$1 ORDER BY s.name`,
      [id],
    )
  ).rows;
  const payment = await one(tx, 'SELECT * FROM payment_requests WHERE order_id=$1', [id]);
  const rejection = await one(
    tx,
    "SELECT notes,verified_at FROM payment_verifications WHERE order_id=$1 AND decision='rejected' ORDER BY verified_at DESC LIMIT 1",
    [id],
  );
  return {
    ...order,
    company_name:
      items.length && items.every((item) => item.team_name === items[0].team_name)
        ? items[0].team_name
        : '',
    company_locked: Boolean(await priorCompany(tx, order)),
    items,
    payment_request: payment ?? null,
    rejection: order.status === 'rejected' ? (rejection ?? null) : null,
    resume_step: resume(order, items),
  };
}
function resume(order: Row, items: Row[]) {
  if (paid.includes(order.status))
    return items.every((i) => i.profile_completed_at) ? 'registered' : 'team_profile';
  return (
    {
      draft: items.length ? 'contact' : 'sports',
      phone_captured: 'invoice',
      invoiced: 'payment',
      payment_pending: 'receipt',
      receipt_submitted: 'awaiting_review',
      under_review: 'awaiting_review',
      rejected: 'receipt',
      cancelled: 'cancelled',
      expired: 'expired',
    } as Record<string, string>
  )[order.status];
}
// The first registration on an account fixes the company identity: later registrations must
// reuse the same company name and logo. Only orders created strictly before this one count.
async function priorCompany(tx: Queryable, order: Row): Promise<Row | undefined> {
  return one(
    tx,
    `SELECT i.team_name AS company_name,i.logo_url
     FROM order_items i JOIN orders o ON o.id=i.order_id
     WHERE o.user_id=$1 AND o.id<>$2 AND o.created_at<$3
       AND o.status NOT IN ('draft','cancelled','expired')
       AND i.team_name IS NOT NULL AND i.team_name<>''
     ORDER BY o.created_at DESC,i.id LIMIT 1`,
    [order.user_id, order.id, order.created_at],
  );
}
export async function audit(
  tx: Queryable,
  adminId: string,
  action: string,
  entityType: string,
  id: string,
  metadata: unknown = {},
) {
  await tx.query(
    'INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [adminId, action, entityType, id, JSON.stringify(metadata)],
  );
}
export async function queueEmail(
  tx: Queryable,
  id: string,
  kind: 'confirmation' | 'manual' = 'confirmation',
  options: { appOrigin?: string; fromAddress?: string } = {},
) {
  const order = await detail(tx, id);
  assert(
    paid.includes(order.status) &&
      order.items.length &&
      order.items.every((i) => i.profile_completed_at),
    409,
    'profiles_incomplete',
    'Payment and every team profile must be complete before sending confirmation',
  );
  const user = (await one(tx, 'SELECT * FROM users WHERE id=$1', [order.user_id]))!;
  const event = await one(tx, 'SELECT * FROM events WHERE active');
  const companyName = order.company_name || order.items[0]?.team_name || user.name;
  const amount = `${Number(order.total_amount).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(order.total_amount)) ? 0 : 2, maximumFractionDigits: 2 })} NPR`;
  const fmtDate = (value: unknown) =>
    new Date(value as string).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const siteUrl = options.appOrigin ?? '';
  const supportEmail =
    /<([^>]+)>/.exec(options.fromAddress ?? '')?.[1] ?? options.fromAddress ?? '';
  const { subject, text, html } = confirmationEmail({
    companyName,
    orderId: id,
    amount,
    teams: order.items.map((i) => ({
      teamName: i.team_name,
      sportName: i.sport_name,
      players: i.players,
    })),
    event: event
      ? {
          title: event.title,
          venue: event.venue,
          startDate: fmtDate(event.start_date),
          endDate: fmtDate(event.end_date),
        }
      : null,
    logoUrl: `${siteUrl}/assets/images/logo.png`,
    siteUrl,
    supportEmail,
  });
  const payload = {
    to: user.email,
    userId: user.id,
    subject,
    text,
    html,
  };
  return one(
    tx,
    `INSERT INTO email_jobs(order_id,kind,payload) VALUES($1,$2,$3::jsonb)
  ON CONFLICT (order_id) WHERE kind='confirmation' DO NOTHING RETURNING id`,
    [id, kind, JSON.stringify(payload)],
  );
}
export class Orders {
  constructor(
    public db: Database,
    public config: Config,
  ) {}
  async owned<T>(userId: string, id: string, fn: (tx: Queryable, order: Row) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      // All captain mutations lock the captain first, then the order. This serializes create/reopen/revise.
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const order = await one(tx, 'SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        id,
        userId,
      ]);
      assert(order, 404, 'not_found', 'Order not found');
      return fn(tx, order);
    });
  }
  async current(userId: string) {
    const order = await one(
      this.db,
      `SELECT id FROM orders WHERE user_id=$1 AND (${openSql} OR status='rejected')
   ORDER BY CASE WHEN status='rejected' THEN 1 ELSE 0 END,created_at DESC LIMIT 1`,
      [userId],
    );
    return order ? detail(this.db, order.id) : null;
  }
  async draft(userId: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      let order = await one(tx, `SELECT id FROM orders WHERE user_id=$1 AND ${openSql}`, [userId]);
      if (!order) {
        order = await one(tx, 'INSERT INTO orders(user_id) VALUES($1) RETURNING id', [userId]);
        await tx.query("INSERT INTO order_status_history(order_id,to_status) VALUES($1,'draft')", [
          order!.id,
        ]);
      }
      return detail(tx, order!.id);
    });
  }
  async list(userId: string) {
    const orders = await this.db.query(
      `SELECT o.id FROM orders o WHERE o.user_id=$1 AND o.status NOT IN ('cancelled','expired')
   AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id) ORDER BY o.created_at DESC`,
      [userId],
    );
    return Promise.all(orders.rows.map((row) => detail(this.db, row.id)));
  }
  async start(userId: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      // Reuse an empty draft so repeated clicks do not pile up clean orders, otherwise
      // always open a fresh registration even when a paid order is still open.
      const order = await one(
        tx,
        `SELECT id FROM orders o WHERE o.user_id=$1 AND o.status='draft'
     AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id) LIMIT 1`,
        [userId],
      );
      if (order) return detail(tx, order.id);
      const fresh = await one(tx, 'INSERT INTO orders(user_id) VALUES($1) RETURNING id', [userId]);
      await tx.query("INSERT INTO order_status_history(order_id,to_status) VALUES($1,'draft')", [
        fresh!.id,
      ]);
      return detail(tx, fresh!.id);
    });
  }
  async sports(userId: string, id: string, input: z.infer<typeof teamSelection>) {
    return this.owned(userId, id, async (tx, o) => {
      assert(
        ['draft', 'phone_captured'].includes(o.status) && !o.invoiced_at,
        409,
        'invoice_locked',
        'Sports and team names can only change before invoicing',
      );
      const sports = (
        await tx.query('SELECT * FROM sports WHERE id=ANY($1::uuid[]) AND active FOR SHARE', [
          input.sports.map((s) => s.sport_id),
        ])
      ).rows;
      assert(
        sports.length === input.sports.length,
        400,
        'inactive_sport',
        'A selected sport does not exist or is inactive',
      );
      const prior = await priorCompany(tx, o);
      if (prior)
        assert(
          input.company_name === prior.company_name,
          409,
          'company_locked',
          `Your company is already registered as ${prior.company_name} and cannot be changed`,
        );
      const teamName = prior?.company_name ?? input.company_name;
      await tx.query('DELETE FROM order_items WHERE order_id=$1', [id]);
      for (const pick of input.sports)
        await tx.query(
          'INSERT INTO order_items(order_id,sport_id,team_name,logo_url,price_at_purchase) VALUES($1,$2,$3,$4,$5)',
          [
            id,
            pick.sport_id,
            teamName,
            // Reuse the company logo from the earlier registration so it is never re-uploaded.
            prior?.logo_url ?? null,
            sports.find((s) => s.id === pick.sport_id)!.price,
          ],
        );
      // A later registration belongs to the same company and captain. Reuse the verified
      // contact number so the captain can go straight to invoicing.
      if (prior && o.status === 'draft') {
        const user = await one(tx, 'SELECT phone FROM users WHERE id=$1', [userId]);
        assert(
          user?.phone,
          409,
          'contact_required',
          'Add a contact number to your first registration before registering another sport',
        );
        await tx.query('UPDATE orders SET phone_number=$2,updated_at=now() WHERE id=$1', [
          id,
          user.phone,
        ]);
        await transition(tx, o, 'phone_captured');
      }
      await tx.query('UPDATE orders SET updated_at=now() WHERE id=$1', [id]);
      return detail(tx, id);
    });
  }
  async phone(userId: string, id: string, phone: string) {
    return this.owned(userId, id, async (tx, o) => {
      assert(
        ['draft', 'phone_captured'].includes(o.status),
        409,
        'invalid_state',
        'Contact number must be captured before invoicing',
      );
      assert(
        await one(tx, 'SELECT id FROM order_items WHERE order_id=$1 LIMIT 1', [id]),
        409,
        'no_sports',
        'Select a sport first',
      );
      await tx.query('UPDATE orders SET phone_number=$2,updated_at=now() WHERE id=$1', [id, phone]);
      await tx.query('UPDATE users SET phone=$2 WHERE id=$1', [userId, phone]);
      if (o.status !== 'phone_captured') await transition(tx, o, 'phone_captured');
      return detail(tx, id);
    });
  }
  async invoice(userId: string, id: string) {
    return this.owned(userId, id, async (tx, o) => {
      if (o.invoiced_at) return detail(tx, id);
      assert(
        o.status === 'phone_captured',
        409,
        'invalid_state',
        'Capture contact number before invoicing',
      );
      await ensureCapacity(tx, id);
      const items = (
        await tx.query(
          'SELECT i.id,s.price,s.active FROM order_items i JOIN sports s ON s.id=i.sport_id WHERE order_id=$1 FOR SHARE OF s',
          [id],
        )
      ).rows;
      assert(
        items.length && items.every((i) => i.active),
        409,
        'inactive_sport',
        'Choose active sports before invoicing',
      );
      for (const item of items)
        await tx.query('UPDATE order_items SET price_at_purchase=$2 WHERE id=$1', [
          item.id,
          item.price,
        ]);
      await tx.query(
        'UPDATE orders SET total_amount=(SELECT sum(price_at_purchase) FROM order_items WHERE order_id=$1),invoiced_at=now() WHERE id=$1',
        [id],
      );
      await transition(tx, o, 'invoiced');
      return detail(tx, id);
    });
  }
  async payment(userId: string, id: string) {
    const result = await this.owned(userId, id, async (tx, o) => {
      assert(
        ['invoiced', 'payment_pending'].includes(o.status),
        409,
        'invalid_state',
        'Payment requests require an invoiced order',
      );
      const existing = await one(tx, 'SELECT * FROM payment_requests WHERE order_id=$1', [id]);
      if (existing) return existing;
      // The remarks code is stable per account: every registration from the same
      // Google account reuses the same unique code.
      const user = (await one(tx, 'SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]))!;
      let code = user.payment_code;
      if (!code) {
        code = `RONB-${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
        for (let attempt = 0; attempt < 10; attempt++) {
          if (!(await one(tx, 'SELECT id FROM users WHERE payment_code=$1', [code]))) break;
          code = `RONB-${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
        }
        await tx.query('UPDATE users SET payment_code=$2 WHERE id=$1', [userId, code]);
      }
      const p = await one(
        tx,
        `INSERT INTO payment_requests(order_id,unique_code,qr_payload,expires_at) VALUES($1,$2,$3,now()+($4*interval '1 minute')) RETURNING *`,
        [id, code, PAYMENT_BANK_DETAILS, this.config.PAYMENT_EXPIRY_MINUTES],
      );
      await transition(tx, o, 'payment_pending');
      return p!;
    });
    return {
      ...result,
      bank_details: PAYMENT_BANK_DETAILS,
      instructions: PAYMENT_INSTRUCTIONS,
    };
  }
  async receipt(userId: string, id: string, key: string) {
    return this.owned(userId, id, async (tx, o) => {
      assert(
        ['payment_pending', 'receipt_submitted', 'rejected'].includes(o.status),
        409,
        'invalid_state',
        'This order is not accepting receipts',
      );
      const payment = await one(tx, 'SELECT * FROM payment_requests WHERE order_id=$1', [id]);
      assert(payment, 409, 'no_payment_request', 'Request payment instructions first');
      if (o.status === 'payment_pending')
        assert(
          new Date(payment.expires_at).getTime() > Date.now(),
          409,
          'payment_expired',
          'Payment code expired; cancel and revise this order',
        );
      if (o.status === 'rejected') {
        await ensureCapacity(tx, id);
        assert(
          !(await one(tx, `SELECT id FROM orders WHERE user_id=$1 AND ${openSql} AND id<>$2`, [
            userId,
            id,
          ])),
          409,
          'another_open_order',
          'Another registration is open; resolve it before resubmitting this rejected order',
        );
      }
      await tx.query('INSERT INTO receipts(order_id,file_url) VALUES($1,$2)', [id, key]);
      await transition(tx, o, 'receipt_submitted');
      return detail(tx, id);
    });
  }
  async revise(userId: string, id: string) {
    return this.owned(userId, id, async (tx, o) => {
      assert(
        ['draft', 'phone_captured', 'invoiced', 'payment_pending', 'expired', 'rejected'].includes(
          o.status,
        ),
        409,
        'invalid_state',
        'This order cannot be revised',
      );
      assert(
        !(await one(tx, `SELECT id FROM orders WHERE user_id=$1 AND ${openSql} AND id<>$2`, [
          userId,
          id,
        ])),
        409,
        'another_open_order',
        'Another registration is already open',
      );
      await transition(tx, o, 'cancelled', null, 'revised');
      const fresh = (await one(
        tx,
        'INSERT INTO orders(user_id,phone_number) VALUES($1,$2) RETURNING id',
        [userId, o.phone_number],
      ))!;
      await tx.query(
        `INSERT INTO order_items(order_id,sport_id,team_name,price_at_purchase)
    SELECT $2,i.sport_id,i.team_name,s.price FROM order_items i JOIN sports s ON s.id=i.sport_id WHERE i.order_id=$1 AND s.active`,
        [id, fresh.id],
      );
      await tx.query("INSERT INTO order_status_history(order_id,to_status) VALUES($1,'draft')", [
        fresh.id,
      ]);
      return detail(tx, fresh.id);
    });
  }
  async profile(
    userId: string,
    id: string,
    itemId: string,
    input: z.infer<typeof profileInput> & { logo_url?: string },
    complete = false,
  ) {
    return this.owned(userId, id, async (tx, o) => {
      assert(
        paid.includes(o.status),
        409,
        'payment_unconfirmed',
        'Team profiles unlock after payment confirmation',
      );
      return this.applyProfile(tx, o, itemId, input, complete);
    });
  }
  async adminProfile(
    id: string,
    itemId: string,
    input: z.infer<typeof profileInput> & { logo_url?: string },
    complete = false,
  ) {
    return this.db.transaction(async (tx) => {
      const o = await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      assert(o, 404, 'not_found', 'Order not found');
      return this.applyProfile(tx, o!, itemId, input, complete);
    });
  }
  private async applyProfile(
    tx: Queryable,
    o: Row,
    itemId: string,
    input: z.infer<typeof profileInput> & { logo_url?: string },
    complete = false,
  ) {
    const id = o.id;
    const item = await one(tx, 'SELECT * FROM order_items WHERE id=$1 AND order_id=$2', [
      itemId,
      id,
    ]);
    assert(item, 404, 'not_found', 'Team not found');
    const itemSport = await one(
      tx,
      'SELECT s.name FROM sports s JOIN order_items i ON i.sport_id=s.id WHERE i.id=$1',
      [itemId],
    );
    if (complete) {
      const sportRow = await one(
        tx,
        'SELECT s.name AS name FROM order_items i JOIN sports s ON s.id=i.sport_id WHERE i.id=$1',
        [itemId],
      );
      assert(sportRow, 404, 'not_found', 'Team not found');
      const sportName = sportRow.name;
      const requiredPlayers = MIN_ROSTER[sportName.toLowerCase()] ?? 1;
      const rosterRow = await one(
        tx,
        'SELECT count(*)::int AS count, count(*) FILTER (WHERE jersey_size IS NULL)::int AS missing_sizes, count(*) FILTER (WHERE photo_url IS NULL)::int AS missing_photos FROM team_players WHERE order_item_id=$1',
        [itemId],
      );
      const rosterCount = rosterRow!.count;
      assert(
        item.logo_url && rosterCount >= requiredPlayers,
        409,
        'profile_incomplete',
        `Add a logo and at least ${requiredPlayers} player${requiredPlayers > 1 ? 's' : ''} before completing the ${sportName} profile`,
      );
      assert(
        rosterRow!.missing_sizes === 0,
        409,
        'jersey_sizes_required',
        'Choose a jersey size for every player before completing the profile',
      );
      if (sportName.toLowerCase() === 'cricksal')
        assert(
          item.jersey_style !== null,
          409,
          'jersey_styles_required',
        'Choose full sleeve or half sleeve for the Cricksal team before completing the profile',
        );
      assert(
        rosterRow!.missing_photos === 0,
        409,
        'player_photos_required',
        'Add a photo for every player before completing the profile',
      );
      await tx.query(
        'UPDATE order_items SET profile_completed_at=coalesce(profile_completed_at,now()) WHERE id=$1',
        [itemId],
      );
      const incomplete = await one(
        tx,
        'SELECT id FROM order_items WHERE order_id=$1 AND profile_completed_at IS NULL LIMIT 1',
        [id],
      );
      if (!incomplete)
        await queueEmail(tx, id, 'confirmation', {
          appOrigin: this.config.APP_ORIGIN,
          fromAddress: this.config.EMAIL_FROM,
        });
    } else {
      assert(
        input.jersey_sizes === undefined ||
          (input.players !== undefined && input.jersey_sizes.length === input.players.length),
        400,
        'invalid_jersey_sizes',
        'Send one jersey size per player together with the roster',
      );
      const teamJerseyStyle = input.jersey_style ?? input.jersey_styles?.find(Boolean) ?? null;
      assert(input.jersey_style !== undefined || input.jersey_styles !== undefined || itemSport?.name.toLowerCase() !== 'cricksal', 400, 'invalid_jersey_style', 'Send the team jersey style together with the roster');
      assert(
        input.players !== undefined ||
          input.logo_url !== undefined ||
          input.captain_position !== undefined,
        400,
        'empty_update',
        'Provide players, a captain, or a logo',
      );
      const captainPosition =
        input.captain_position !== undefined
          ? input.captain_position
          : input.players !== undefined
            ? null
            : item.captain_position;
      if (captainPosition !== null) {
        const roster =
          input.players ?? (await detail(tx, id)).items.find((i) => i.id === itemId)!.players;
        assert(
          captainPosition < roster.length,
          400,
          'invalid_captain',
          'Choose a captain from the listed players',
        );
      }
      await tx.query('UPDATE order_items SET captain_position=$2 WHERE id=$1', [
        itemId,
        captainPosition,
      ]);
      if (input.jersey_style !== undefined || input.jersey_styles !== undefined)
        await tx.query('UPDATE order_items SET jersey_style=$2 WHERE id=$1', [itemId, teamJerseyStyle]);
      if (input.logo_url) {
        if (item.logo_url) {
          const prior = await priorCompany(tx, o);
          assert(
            !prior,
            409,
            'logo_locked',
            'Your company logo is shared across all registrations and cannot be replaced',
          );
        }
        await tx.query('UPDATE order_items SET logo_url=$2 WHERE order_id=$1 AND team_name=$3', [
          id,
          input.logo_url,
          item.team_name,
        ]);
      }
      if (input.players) {
        await tx.query('DELETE FROM team_players WHERE order_item_id=$1', [itemId]);
        for (const [position, name] of input.players.entries())
          await tx.query(
            'INSERT INTO team_players(order_item_id,player_name,position,jersey_size,jersey_style,photo_url) VALUES($1,$2,$3,$4,$5,$6)',
            [
              itemId,
              name,
              position,
              input.jersey_sizes?.[position] ?? null,
              null,
              input.player_photos?.[position] ?? null,
            ],
          );
        // An edited roster with missing sizes must be completed again.
        if (
          !input.jersey_sizes ||
          input.jersey_sizes.some((size) => size === null) ||
          !input.players.length
        )
          await tx.query('UPDATE order_items SET profile_completed_at=NULL WHERE id=$1', [itemId]);
      }
    }
    await tx.query('UPDATE orders SET updated_at=now() WHERE id=$1', [id]);
    return (await detail(tx, id)).items.find((i) => i.id === itemId);
  }
}
