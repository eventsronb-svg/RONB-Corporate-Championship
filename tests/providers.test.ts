import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { resendMailer, s3Storage, validateFile, DeliveryError } from '../src/providers.js';
import { config } from '../src/config.js';
import vercelHandler from '../src/app.js';
const base = {
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'test',
  COOKIE_SECRET: 'x'.repeat(32),
};
afterEach(() => vi.restoreAllMocks());
it('revalidates unversioned frontend assets in the Vercel adapter', async () => {
  const server = createServer(vercelHandler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    for (const path of [
      '/register',
      '/assets/site.js?v=20260916-2',
      '/assets/admin.js?v=20260916-2',
      '/assets/site.css',
      '/assets/championship.json',
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(await response.text()).not.toBe('');
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it('uses the real Resend adapter with the exact immutable payload and idempotency key', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ id: 'email-123' }), { status: 200 }));
  const c = config({
    ...base,
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Events <events@example.com>',
  });
  const payload = {
    userId: 'user-id',
    to: 'captain@example.com',
    subject: 'Registration confirmed',
    text: 'Valley Strikers are registered.',
  };
  expect(await resendMailer(c).send(payload, 'email-job/test')).toBe('email-123');
  const [url, options] = fetch.mock.calls[0];
  expect(String(url)).toBe('https://api.resend.com/emails');
  expect(new Headers(options?.headers).get('Idempotency-Key')).toBe('email-job/test');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(String(options?.body))).toMatchObject({
    from: c.EMAIL_FROM,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
  });
});
it('classifies transient and permanent errors from the Resend response', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({ name: 'rate_limit_exceeded', message: 'Slow down', statusCode: 429 }),
        { status: 429 },
      ),
    );
  const mailer = resendMailer(
    config({ ...base, RESEND_API_KEY: 're_test', EMAIL_FROM: 'events@example.com' }),
  );
  const p = { userId: 'u', to: 'captain@example.com', subject: 'Confirmed', text: 'Registered' };
  await expect(mailer.send(p, 'key')).rejects.toMatchObject({ transient: true });
  fetch.mockResolvedValue(
    new Response(
      JSON.stringify({ name: 'validation_error', message: 'Invalid sender', statusCode: 422 }),
      { status: 422 },
    ),
  );
  await expect(mailer.send(p, 'key')).rejects.toMatchObject({ transient: false });
});
it('sends files to separate S3 buckets and signs private receipt reads for five minutes', async () => {
  const requests: { method: string; url: string; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    requests.push({ method: req.method!, url: req.url!, body: Buffer.concat(buffers) });
    res.statusCode = req.method === 'DELETE' ? 204 : 200;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const storage = s3Storage(
      config({
        ...base,
        S3_ENDPOINT: `http://127.0.0.1:${port}`,
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret',
        S3_LOGOS_PUBLIC_URL: 'https://logos.example',
      }),
    );
    const buffer = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const receipt = await storage.put('receipt', buffer, 'image/png');
    const logo = await storage.put('logo', buffer, 'image/png');
    expect(receipt.url).toMatch(/^receipts\//);
    expect(logo.url).toMatch(/^https:\/\/logos.example\/team-logos\//);
    expect(requests[0].url).toContain('/booking-private/receipts/');
    expect(requests[1].url).toContain('/booking-public/team-logos/');
    expect(requests[0].body).toEqual(buffer);
    const signed = new URL(await storage.signReceipt(receipt.key));
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(signed.searchParams.has('X-Amz-Signature')).toBe(true);
    await storage.remove('receipt', receipt.key);
    expect(requests.at(-1)?.method).toBe('DELETE');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
it('normalizes images, limits logo dimensions, and rejects malformed or oversized uploads', async () => {
  const jpeg = await sharp({
    create: { width: 1600, height: 800, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .toBuffer();
  const result = await validateFile(jpeg, 'image/jpeg', 'logo');
  const metadata = await sharp(result.buffer).metadata();
  expect(result.mime).toBe('image/png');
  expect(metadata.width).toBe(1024);
  expect(metadata.height).toBe(512);
  await expect(
    validateFile(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png', 'logo'),
  ).rejects.toMatchObject({ code: 'invalid_file' });
  await expect(
    validateFile(Buffer.from('%PDF-1.7\n'), 'application/pdf', 'logo'),
  ).rejects.toMatchObject({ code: 'invalid_file' });
  await expect(
    validateFile(Buffer.from('not a pdf'), 'application/pdf', 'receipt'),
  ).rejects.toMatchObject({ code: 'invalid_file' });
});
it('fails closed for missing provider settings and shared public/private buckets', async () => {
  expect(() =>
    config({ ...base, S3_RECEIPTS_BUCKET: 'shared', S3_LOGOS_BUCKET: 'shared' }),
  ).toThrow('distinct');
  expect(() => config({ ...base, NODE_ENV: 'production' })).toThrow('GOOGLE_CLIENT_ID');
  const c = config(base);
  await expect(s3Storage(c).put('receipt', Buffer.from('x'), 'image/png')).rejects.toMatchObject({
    statusCode: 503,
  });
  await expect(
    resendMailer(c).send(
      { userId: 'u', to: 'captain@example.com', subject: 's', text: 't' },
      'key',
    ),
  ).rejects.toBeInstanceOf(DeliveryError);
});
