// Restores the confirmed slot order after the E/F membership correction.
// Apply: npx tsx --env-file=.env scripts/fix-futsal-ef-order.ts --apply
import { config } from '../src/config.js';
import { one, postgres } from '../src/db.js';

const action = 'futsal.groups_e_f.order.2026-10-10';
const slots = [
  ['E', 'Sushree', 16], ['E', 'Nepal Telecom', 17], ['E', 'FECON', 18], ['E', 'Nepal SBI', 19],
  ['F', 'Ncell', 20], ['F', 'Civil Aviation', 21], ['F', 'IME Group', 22], ['F', 'CG Holding', 23],
] as const;
const db = postgres(config().DATABASE_URL);
try {
  if (!process.argv.includes('--apply')) console.log(JSON.stringify(slots));
  else await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(427193)');
    if (await one(tx, 'SELECT id FROM audit_logs WHERE action=$1', [action]))
      throw new Error('The E/F slot order is already corrected.');
    const admin = await one<{ id: string }>(tx, "SELECT id FROM admins WHERE active AND role='super_admin' ORDER BY created_at LIMIT 1");
    if (!admin) throw new Error('An active super admin is required');
    for (const [group, name, offset] of slots) {
      const team = await one<{ id: string }>(tx, 'SELECT id FROM futsal_teams WHERE group_code=$1 AND team_name=$2 FOR UPDATE', [group, name]);
      if (!team) throw new Error(`Missing ${group}${offset}: ${name}`);
      await tx.query('UPDATE futsal_teams SET group_assigned_at=$1 WHERE id=$2', [new Date(Date.UTC(2026, 9, 9, 0, 0, offset)), team.id]);
    }
    await tx.query("INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'futsal',$3,$4::jsonb)", [admin.id, action, admin.id, JSON.stringify({ slots })]);
  });
  if (process.argv.includes('--apply')) console.log('Committed: Groups E/F slots are E1–E4 and F1–F4 as confirmed.');
} finally { await db.close(); }
