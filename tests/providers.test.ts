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
  const requests: {
    method: string;
    url: string;
    body: Buffer;
    headers: import('node:http').IncomingHttpHeaders;
  }[] = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    requests.push({
      method: req.method!,
      url: req.url!,
      body: Buffer.concat(buffers),
      headers: req.headers,
    });
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
    const optimized = await validateFile(buffer, 'image/png', 'logo');
    const receipt = await storage.put('receipt', optimized.buffer, optimized.mime);
    const logo = await storage.put('logo', optimized.buffer, optimized.mime);
    expect(receipt.url).toMatch(/^receipts\//);
    expect(logo.url).toMatch(/^https:\/\/logos.example\/team-logos\//);
    expect(requests[0].url).toContain('/booking-private/receipts/');
    expect(requests[1].url).toContain('/booking-public/team-logos/');
    expect(requests[0].body).toEqual(optimized.buffer);
    expect(receipt.key).toMatch(/\.webp$/);
    expect(logo.key).toMatch(/\.webp$/);
    expect(requests[0].headers['content-type']).toBe('image/webp');
    expect(requests[0].headers['cache-control']).toBe('private, no-store');
    expect(requests[1].headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const pdf = Buffer.from('%PDF-1.7\n');
    const storedPdf = await storage.put('receipt', pdf, 'application/pdf');
    expect(storedPdf.key).toMatch(/\.pdf$/);
    expect(requests[2].body).toEqual(pdf);
    expect(requests[2].headers['content-type']).toBe('application/pdf');
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
it('normalizes images, preserves original logo dimensions, and rejects malformed or oversized uploads', async () => {
  const jpeg = await sharp({
    create: { width: 1600, height: 800, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .toBuffer();
  const result = await validateFile(jpeg, 'image/jpeg', 'logo');
  const metadata = await sharp(result.buffer).metadata();
  expect(result.mime).toBe('image/webp');
  expect(metadata.format).toBe('webp');
  expect(metadata.width).toBe(1600);
  expect(metadata.height).toBe(800);
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

it('compresses receipt images while retaining resolution and close pixel fidelity', async () => {
  const width = 1200;
  const height = 600;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.round((x / width) * 255);
      pixels[offset + 1] = Math.round((y / height) * 255);
      pixels[offset + 2] = Math.round(((x + y) / (width + height)) * 255);
    }
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const result = await validateFile(input, 'image/png', 'receipt');
  const decoded = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info.width).toBe(width);
  expect(decoded.info.height).toBe(height);
  expect(result.buffer.length).toBeLessThan(input.length / 2);
  let error = 0;
  for (let i = 0; i < pixels.length; i++) error += Math.abs(pixels[i] - decoded.data[i]);
  expect(error / pixels.length).toBeLessThan(3);
});

it('preserves transparency without upscaling and corrects orientation before stripping metadata', async () => {
  const transparent = await sharp({
    create: {
      width: 24,
      height: 12,
      channels: 4,
      background: { r: 40, g: 90, b: 150, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const logo = await validateFile(transparent, 'image/png', 'logo');
  const alpha = await sharp(logo.buffer).ensureAlpha().extractChannel(3).raw().toBuffer();
  const originalAlpha = await sharp(transparent).extractChannel(3).raw().toBuffer();
  expect(alpha).toEqual(originalAlpha);
  expect(await sharp(logo.buffer).metadata()).toMatchObject({
    width: 24,
    height: 12,
    hasAlpha: true,
  });

  const rotated = await sharp({
    create: { width: 120, height: 60, channels: 3, background: '#759585' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const receipt = await validateFile(rotated, 'image/jpeg', 'receipt');
  const metadata = await sharp(receipt.buffer).metadata();
  expect(metadata).toMatchObject({ width: 60, height: 120 });
  expect(metadata.orientation).toBeUndefined();
  expect(metadata.exif).toBeUndefined();
  const webp = await validateFile(logo.buffer, 'image/webp', 'logo');
  expect((await sharp(webp.buffer).metadata()).format).toBe('webp');
});

it('keeps receipt PDFs unchanged and rejects corrupt images', async () => {
  const buffer = Buffer.from('%PDF-1.7\n');
  expect(await validateFile(buffer, 'application/pdf', 'receipt')).toEqual({
    buffer,
    mime: 'application/pdf',
  });
  await expect(validateFile(Buffer.from('broken'), 'image/jpeg', 'receipt')).rejects.toMatchObject({
    code: 'invalid_file',
  });
});
