// Organizer-authorized correction for the editable Group A placeholder.
// Preview: npx tsx --env-file=.env scripts/update-futsal-under-review.ts
// Apply:   npx tsx --env-file=.env scripts/update-futsal-under-review.ts --apply
import sharp from 'sharp';
import { config } from '../src/config.js';
import { one, postgres } from '../src/db.js';
import { s3Storage } from '../src/providers.js';

const action = 'futsal.under_review.placeholder.2026-10-10';
const c = config();
const db = postgres(c.DATABASE_URL);
const storage = s3Storage(c);
let uploaded: { key: string; url: string } | undefined;
let committed = false;

try {
  const current = await one<{ id: string; order_item_id: string; team_name: string }>(
    db,
    "SELECT id,order_item_id,team_name FROM futsal_teams WHERE group_code='A' AND team_name IN ('To Be Continued','Under Review') FOR UPDATE",
  );
  if (!current) throw new Error('Group A placeholder was not found');
  console.log(JSON.stringify({ apply: process.argv.includes('--apply'), current: current.team_name, next: 'Under Review' }));
  if (!process.argv.includes('--apply') || current.team_name === 'Under Review') {
    if (current.team_name === 'Under Review') console.log('Already corrected.');
  } else {
    if (await one(db, 'SELECT id FROM audit_logs WHERE action=$1', [action]))
      throw new Error('This placeholder correction has already been applied.');
    const blackLogo = await sharp({
      create: { width: 640, height: 640, channels: 4, background: '#000000' },
    })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer();
    uploaded = await storage.put('logo', blackLogo, 'image/webp');
    const response = await fetch(uploaded.url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Placeholder logo is not publicly readable: ${response.status}`);
    if ((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format !== 'webp')
      throw new Error('Uploaded placeholder logo is invalid');
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(427193)');
      const team = await one<{ id: string; order_item_id: string }>(
        tx,
        "SELECT id,order_item_id FROM futsal_teams WHERE group_code='A' AND team_name='To Be Continued' FOR UPDATE",
      );
      if (!team) throw new Error('Placeholder changed concurrently; no update was made.');
      const admin = await one<{ id: string }>(
        tx,
        "SELECT id FROM admins WHERE active AND role='super_admin' ORDER BY created_at LIMIT 1",
      );
      if (!admin) throw new Error('An active super admin is required');
      await tx.query('UPDATE order_items SET team_name=$1,logo_url=$2 WHERE id=$3', [
        'Under Review',
        uploaded!.url,
        team.order_item_id,
      ]);
      await tx.query('UPDATE futsal_teams SET team_name=$1,logo_url=$2 WHERE id=$3', [
        'Under Review',
        uploaded!.url,
        team.id,
      ]);
      await tx.query(
        "INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'futsal',$3,$4::jsonb)",
        [admin.id, action, team.id, JSON.stringify({ previousName: 'To Be Continued', name: 'Under Review', logo: 'solid black' })],
      );
    });
    committed = true;
    console.log('Committed: Group A placeholder is Under Review with a solid black logo.');
  }
} finally {
  if (!committed && uploaded) await storage.remove('logo', uploaded.key).catch(() => undefined);
  await db.close();
}
