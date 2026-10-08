import { config } from './config.js';
import { postgres, migrate, baseline, one } from './db.js';
import { z } from 'zod';
// Same as server.ts: hosts run `node dist/cli.js migrate` without node flags.
try {
    process.loadEnvFile();
}
catch {
    // No .env file: the process environment already carries the configuration.
}
const c = config();
const db = postgres(c.DATABASE_URL);
try {
    if (process.argv[2] === 'migrate') {
        await migrate(db);
        console.info('Migrations applied');
    }
    else if (process.argv[2] === 'baseline') {
        // Records migrations as applied without running them, for a database that was
        // created before the migration runner existed. Refuses if the schema is absent.
        const marked = await baseline(db, z.string().parse(process.argv[3]));
        console.info(`Recorded ${marked.length} migrations as applied: ${marked.join(', ')}`);
        console.info('Run `migrate` next to apply anything newer.');
    }
    else if (process.argv[2] === 'seed') {
        const email = z.string().email().parse(process.env.SEED_ADMIN_EMAIL).toLowerCase();
        await db.transaction(async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(427192)');
            if (await one(tx, 'SELECT id FROM admins LIMIT 1'))
                throw new Error('Admin allowlist already exists; use the admin panel to manage it');
            await tx.query("INSERT INTO admins(email,role) VALUES($1,'super_admin')", [email]);
        });
        console.info('Initial super admin added. Sign in with the allowlisted Google account.');
    }
    else
        throw new Error('Use migrate, baseline <migration-file> or seed');
}
finally {
    await db.close();
}
//# sourceMappingURL=cli.js.map