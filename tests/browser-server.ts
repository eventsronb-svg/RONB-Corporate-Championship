import { setup } from './helpers.js';
const h = await setup();
await h.submit();
await h.app.listen({ port: 3000, host: '127.0.0.1' });
async function stop() {
  await h.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
