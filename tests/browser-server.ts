import { setup } from './helpers.js';
import { deliverOne } from '../src/jobs.js';
const h = await setup();
h.setIdentity({ googleId: 'e2e-captain', email: 'e2e-captain@example.com', name: 'E2E Captain' });
// Available only in this isolated fixture server, never in the application.
h.app.post('/__test/deliver', async () => {
  while (await deliverOne(h.db, h.mailer)) {}
  return { sent: h.sent.length };
});
h.app.post<{ Params: { id: string } }>('/__test/expire/:id', async (req) => {
  await h.db.query(
    "UPDATE payment_requests SET expires_at=now()-interval '1 minute' WHERE order_id=$1",
    [req.params.id],
  );
  return { ok: true };
});
await h.submit();
await h.app.listen({ port: Number(process.env.PORT ?? 3000), host: '127.0.0.1' });
async function stop() {
  await h.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
