// Organizer-authorized replacement of the October 2026 futsal field.
// Preview: npx tsx --env-file=.env scripts/stage-final-futsal.ts
// Apply:   npx tsx --env-file=.env scripts/stage-final-futsal.ts --apply
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { postgres, one } from '../src/db.js';
import { s3Storage } from '../src/providers.js';

const field = [
  ['A', 'Xtreme', 'Xtreme.png'],
  ['A', 'Pace x', 'Pace X.png'],
  ['A', 'Buddha Air', 'Buddha Air Pvt. Ltd.jpg'],
  ['A', 'Pathao', 'Pathao.svg'],
  ['B', 'Surya Jyoti Insurance', 'Surya Jyoti Insurance.jpg'],
  ['B', 'CG Net', 'CG Net.svg'],
  ['B', 'Nabil Bank', 'Nabil Bank.jpg'],
  ['B', 'KIEC', 'KIEC.jpg'],
  ['C', 'Studsphere', 'Studsphere.jpg'],
  ['C', 'Techspire', 'Techspire.webp'],
  ['C', 'Club Nova', 'Club Nova.avif'],
  ['C', 'Jupiter X', null, 'JX'],
  ['D', 'Neema Education', 'Neema Educaation Foundation.jpg'],
  ['D', 'Global IME', 'Global IME.jpg'],
  ['D', 'Prabhu Bank', 'Prabhu Bank.jpg'],
  ['D', 'KUKL', 'KUKL.jpg'],
  ['E', 'Sushree', 'Sushree.jpg'],
  ['E', 'Nepal Telecom', 'Nepal Telecom Limited.png'],
  ['E', 'FECON', 'FECON.jpg'],
  ['E', 'Nepal SBI', 'SBI Bank.jpg'],
  ['F', 'Ncell', 'Ncell.jpg'],
  ['F', 'Himalaya Hive', null, 'HH'],
  ['F', 'IME Group', 'IME Group.jpg'],
  ['F', 'CG Holding', 'CG Holdings.jpg'],
] as const;
const action = 'futsal.final_field.stage.2026-10-09';
const resources = '/Users/ronbstudios/Desktop/Teams as a whole/resources';
const c = config();
const db = postgres(c.DATABASE_URL);
const storage = s3Storage(c);
const uploaded: { key: string; url: string }[] = [];
let committed = false;
try {
  // Decode every source before any database mutation or remote upload.
  const logos: { group: string; name: string; file: string; buffer: Buffer }[] = [];
  for (const [group, name, file, letters] of field) {
    const source = file
      ? await readFile(join(resources, file))
      : Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" rx="48" fill="#152619"/><text x="320" y="340" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="240" font-weight="700" fill="#ffffff">${letters}</text></svg>`,
        );
    const buffer = await sharp(source)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer();
    logos.push({ group, name, file: file ?? `${letters} text`, buffer });
  }
  console.log(
    JSON.stringify(
      {
        apply: process.argv.includes('--apply'),
        teams: logos.map(({ buffer, ...logo }) => ({ ...logo, bytes: buffer.length })),
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--apply')) {
    if (await one(db, 'SELECT id FROM audit_logs WHERE action=$1', [action]))
      throw new Error(
        'This final field has already been staged. Refusing to replace subsequent admin edits.',
      );
    const directory = resolve(
      '.data',
      `futsal-final-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const backup = await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tables = (
        await tx.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows;
      const data: Record<string, unknown> = {};
      for (const { tablename } of tables)
        data[tablename] = (
          await tx.query(`SELECT * FROM "${String(tablename).replaceAll('"', '""')}"`)
        ).rows;
      return data;
    });
    const backupPath = join(directory, 'database-before.json');
    await writeFile(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
    console.log(`Backup saved: ${backupPath}`);
    for (const logo of logos) {
      const stored = await storage.put('logo', logo.buffer, 'image/webp');
      uploaded.push(stored);
      const response = await fetch(stored.url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok)
        throw new Error(`Logo for ${logo.name} is not publicly readable: ${response.status}`);
      const info = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      if (info.format !== 'webp') throw new Error(`Invalid uploaded logo for ${logo.name}`);
      console.log(`Uploaded and verified: ${logo.name}`);
    }
    await writeFile(
      join(directory, 'logos.json'),
      JSON.stringify(
        logos.map((logo, index) => ({
          group: logo.group,
          name: logo.name,
          source: logo.file,
          ...uploaded[index],
        })),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(427193)');
      await tx.query(
        'LOCK TABLE sports, orders, order_items, team_players, futsal_teams, futsal_matches, futsal_scorers, futsal_tie_decisions, futsal_third_place_draw, email_jobs IN SHARE ROW EXCLUSIVE MODE',
      );
      if (await one(tx, 'SELECT id FROM audit_logs WHERE action=$1', [action]))
        throw new Error('Already staged');
      const sport = await one(tx, "SELECT * FROM sports WHERE lower(name)='futsal'");
      const admin = await one(
        tx,
        "SELECT id FROM admins WHERE active AND role='super_admin' ORDER BY created_at LIMIT 1",
      );
      if (!sport || !admin) throw new Error('Futsal sport and active super admin are required');
      const oldItems = (
        await tx.query(
          'SELECT i.*,o.status FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sport_id=$1',
          [sport.id],
        )
      ).rows;
      const oldOrderIds = [...new Set(oldItems.map((item) => item.order_id))];
      // Refuse an unexpected shared order; its other sports must stay intact.
      const shared = await one(
        tx,
        'SELECT id FROM order_items WHERE order_id=ANY($1::uuid[]) AND sport_id<>$2 LIMIT 1',
        [oldOrderIds, sport.id],
      );
      if (shared)
        throw new Error(
          'A futsal registration shares an order with another sport; review it before replacing.',
        );
      await tx.query('DELETE FROM futsal_scorers');
      await tx.query('DELETE FROM futsal_tie_decisions');
      await tx.query('DELETE FROM futsal_third_place_draw');
      await tx.query('DELETE FROM futsal_matches');
      await tx.query('DELETE FROM futsal_teams');
      // Invoiced items are immutable. Archive their orders instead of deleting
      // billing records; cancelled entries cannot appear in Teams or be imported.
      // Keep payments, receipts, rosters, verifications and history as an archive.
      await tx.query(
        "INSERT INTO order_status_history(order_id,from_status,to_status,changed_by) SELECT id,status,'cancelled',$2 FROM orders WHERE id=ANY($1::uuid[]) AND status<>'cancelled'",
        [oldOrderIds, admin.id],
      );
      await tx.query(
        "UPDATE orders SET status='cancelled',cancellation_reason='revised',updated_at=now() WHERE id=ANY($1::uuid[])",
        [oldOrderIds],
      );
      await tx.query(
        "UPDATE email_jobs SET status='failed',last_error='Archived during organizer-authorized final futsal replacement',locked_at=null,lease_token=null WHERE order_id=ANY($1::uuid[]) AND status IN ('pending','processing')",
        [oldOrderIds],
      );
      await tx.query(
        "UPDATE sports SET active=false WHERE lower(name) IN ('futsal','cricksal','crickshal')",
      );
      await tx.query('UPDATE sports SET max_teams=24 WHERE id=$1', [sport.id]);
      for (const [index, logo] of logos.entries()) {
        // Reserved .invalid emails cannot reach participants. No mail is queued.
        const token = randomUUID();
        const user = (await one(
          tx,
          'INSERT INTO users(google_id,email,name) VALUES($1,$2,$3) RETURNING id',
          [`organizer-staged-${token}`, `futsal-${token}@staged.invalid`, logo.name],
        ))!;
        const order = (await one(
          tx,
          "INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id",
          [user.id],
        ))!;
        const item = (await one(
          tx,
          'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name,logo_url) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [order.id, sport.id, sport.price, logo.name, uploaded[index].url],
        ))!;
        await tx.query(
          'INSERT INTO futsal_teams(order_item_id,team_name,logo_url,group_code,group_assigned_at) VALUES($1,$2,$3,$4,$5)',
          [
            item.id,
            logo.name,
            uploaded[index].url,
            logo.group,
            new Date(Date.UTC(2026, 9, 9, 0, 0, index)),
          ],
        );
        await tx.query(
          "INSERT INTO order_status_history(order_id,from_status,to_status,changed_by) VALUES($1,null,'confirmed',$2)",
          [order.id, admin.id],
        );
        await tx.query(
          "INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,'order.organizer_stage','order',$2,$3::jsonb)",
          [
            admin.id,
            order.id,
            JSON.stringify({
              reason:
                'Finalized futsal field supplied by organizer; contact and roster details pending admin entry. This is not a payment verification.',
              group: logo.group,
              company: logo.name,
            }),
          ],
        );
      }
      await tx.query(
        "INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'futsal',$3,$4::jsonb)",
        [
          admin.id,
          action,
          sport.id,
          JSON.stringify({
            backupPath,
            archivedItems: oldItems.length,
            archivedOrders: oldOrderIds,
            teams: logos.map(({ group, name }) => ({ group, name })),
            fixturesGenerated: false,
          }),
        ],
      );
      const groups = (
        await tx.query(
          'SELECT group_code,count(*)::int AS count FROM futsal_teams GROUP BY group_code ORDER BY group_code',
        )
      ).rows;
      if (groups.length !== 6 || groups.some((group) => group.count !== 4))
        throw new Error('Final group validation failed');
    });
    committed = true;
    console.log(
      'Committed: 24 futsal teams, groups A–F, registrations closed, no fixtures, no players, no outgoing emails.',
    );
  }
} finally {
  if (!committed)
    for (const file of uploaded)
      await storage
        .remove('logo', file.key)
        .catch(() => console.error(`Upload cleanup failed: ${file.key}`));
  await db.close();
}
