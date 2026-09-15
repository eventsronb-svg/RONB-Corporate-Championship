import { config } from './config.js';
import { postgres, migrate, one } from './db.js';
import { z } from 'zod';
const c = config();
const db = postgres(c.DATABASE_URL);
try {
  if (process.argv[2] === 'migrate') {
    await migrate(db);
    console.info('Migrations applied');
  } else if (process.argv[2] === 'seed') {
    const email = z.string().email().parse(process.env.SEED_ADMIN_EMAIL).toLowerCase();
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(427192)');
      if (await one(tx, 'SELECT id FROM admins LIMIT 1'))
        throw new Error('Admin allowlist already exists; use the admin panel to manage it');
      await tx.query("INSERT INTO admins(email,role) VALUES($1,'super_admin')", [email]);
    });
    console.info('Initial super admin added. Sign in with the allowlisted Google account.');
  } else throw new Error('Use migrate or seed');
} finally {
  await db.close();
}
