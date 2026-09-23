import { config } from './config.js';
import { postgres } from './db.js';
import { buildApp } from './app.js';
import { googleProvider, s3Storage } from './providers.js';
// Process supervisors such as cPanel's Application Manager run this file directly,
// without `npm start`'s `--env-file-if-exists=.env` flag. Loading `.env` here keeps
// both run styles working; variables already present in the environment win.
try {
  process.loadEnvFile();
} catch {
  // No .env file: the process environment already carries the configuration.
}
const c = config();
const db = postgres(c.DATABASE_URL);
const app = await buildApp({
  db,
  config: c,
  google: googleProvider(c),
  storage: s3Storage(c),
  logger: true,
});
async function shutdown() {
  await app.close();
  await db.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host: '0.0.0.0', port: c.PORT });
