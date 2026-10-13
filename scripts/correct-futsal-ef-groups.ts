// Organizer-authorized correction to make production Groups E/F match the confirmed draw.
// Preview: npx tsx --env-file=.env scripts/correct-futsal-ef-groups.ts
// Apply:   npx tsx --env-file=.env scripts/correct-futsal-ef-groups.ts --apply
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { one, postgres } from '../src/db.js';
import { s3Storage } from '../src/providers.js';

const action = 'futsal.groups_e_f.correct.2026-10-10';
const telecomLogo = 'C:/Users/LENOVO/Downloads/Teams as a whole/resources/Nepal Telecom Limited.png';
const c = config();
const db = postgres(c.DATABASE_URL);
const storage = s3Storage(c);
let uploaded: { key: string; url: string } | undefined;
let committed = false;

try {
  const before = await db.query<{ group_code: string; team_name: string }>(
    "SELECT group_code,team_name FROM futsal_teams WHERE group_code IN ('E','F') ORDER BY group_code,group_assigned_at,id",
  );
  console.log(JSON.stringify({ apply: process.argv.includes('--apply'), before: before.rows }, null, 2));
  if (process.argv.includes('--apply')) {
    if (await one(db, 'SELECT id FROM audit_logs WHERE action=$1', [action]))
      throw new Error('This E/F correction has already been applied.');
    const normalized = await sharp(await readFile(telecomLogo))
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer();
    uploaded = await storage.put('logo', normalized, 'image/webp');
    const response = await fetch(uploaded.url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Nepal Telecom logo is not publicly readable: ${response.status}`);
    if ((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format !== 'webp')
      throw new Error('Uploaded Nepal Telecom logo is invalid');
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(427193)');
      const fixtures = await one<{ count: number }>(tx, 'SELECT count(*)::int AS count FROM futsal_matches');
      if (fixtures?.count) throw new Error('Futsal fixtures already exist; do not change the confirmed groups.');
      const civil = await one<{ id: string }>(
        tx,
        "SELECT id FROM futsal_teams WHERE team_name='Civil Aviation' AND group_code='E' FOR UPDATE",
      );
      const hive = await one<{ id: string; order_item_id: string }>(
        tx,
        "SELECT id,order_item_id FROM futsal_teams WHERE team_name='Himalaya Hive' AND group_code='F' FOR UPDATE",
      );
      const admin = await one<{ id: string }>(
        tx,
        "SELECT id FROM admins WHERE active AND role='super_admin' ORDER BY created_at LIMIT 1",
      );
      if (!civil || !hive || !admin) throw new Error('Expected E/F teams or an active super admin are missing.');
      await tx.query('UPDATE futsal_teams SET group_code=$1,group_assigned_at=$2 WHERE id=$3', [
        'F', new Date(Date.UTC(2026, 9, 10, 0, 0, 1)), civil.id,
      ]);
      await tx.query('UPDATE order_items SET team_name=$1,logo_url=$2 WHERE id=$3', [
        'Nepal Telecom', uploaded!.url, hive.order_item_id,
      ]);
      await tx.query('UPDATE futsal_teams SET team_name=$1,logo_url=$2,group_code=$3,group_assigned_at=$4 WHERE id=$5', [
        'Nepal Telecom', uploaded!.url, 'E', new Date(Date.UTC(2026, 9, 10, 0, 0, 1)), hive.id,
      ]);
      await tx.query(
        "INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'futsal',$3,$4::jsonb)",
        [admin.id, action, hive.id, JSON.stringify({ groupE: ['Sushree', 'Nepal Telecom', 'FECON', 'Nepal SBI'], groupF: ['Ncell', 'Civil Aviation', 'IME Group', 'CG Holding'], removed: 'Himalaya Hive' })],
      );
    });
    committed = true;
    console.log('Committed: Groups E/F now match the confirmed draw.');
  }
} finally {
  if (!committed && uploaded) await storage.remove('logo', uploaded.key).catch(() => undefined);
  await db.close();
}
