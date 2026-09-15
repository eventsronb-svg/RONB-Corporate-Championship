import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const dir = await mkdtemp(join(tmpdir(), 'ronb-postgres-test-'));
const pg = new EmbeddedPostgres({
  databaseDir: join(dir, 'db'),
  port,
  user: 'postgres',
  password: 'local-test-only',
  persistent: false,
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: () => {},
});
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('booking_test');
  console.info(`Running integration tests against native PostgreSQL on port ${port}`);
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://postgres:local-test-only@127.0.0.1:${port}/booking_test`,
    },
  });
  const code = await new Promise<number>((resolve) =>
    child.on('exit', (code) => resolve(code ?? 1)),
  );
  process.exitCode = code;
} finally {
  await pg.stop();
  await rm(dir, { recursive: true, force: true });
}
