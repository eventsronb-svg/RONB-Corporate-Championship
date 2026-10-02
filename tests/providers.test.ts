import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  resendMailer,
  s3Storage,
  validateFile,
  DeliveryError,
  fileToken,
  fileTokenValid,
  hybridStorage,
  localStorage,
} from '../src/providers.js';
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
it('sends files to separate S3 buckets and signs private reads for five minutes', async () => {
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
    const photo = await storage.put('photo', optimized.buffer, optimized.mime);
    expect(photo.url).toMatch(/^player-photos\//);
    expect(requests[3].url).toContain('/player-photos/player-photos/');
    expect(requests[3].headers['cache-control']).toBe('private, no-store');
    const signed = new URL(await storage.signReceipt(receipt.key));
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(signed.searchParams.has('X-Amz-Signature')).toBe(true);
    const signedPhoto = new URL(await storage.signPlayerPhoto(photo.key));
    expect(signedPhoto.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(signedPhoto.searchParams.has('X-Amz-Signature')).toBe(true);
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
it('accepts photos and receipts up to 20 MB while logos stay at 5 MB', async () => {
  // A receipt PDF is returned untouched, so its accepted size can be asserted directly.
  const header = Buffer.from('%PDF-1.7\n');
  const pdf = (bytes: number) => Buffer.concat([header, Buffer.alloc(bytes - header.length)]);
  const sixMb = await validateFile(pdf(6 * 1024 * 1024), 'application/pdf', 'receipt');
  expect(sixMb.buffer.length).toBe(6 * 1024 * 1024);
  expect(sixMb.mime).toBe('application/pdf');
  await expect(
    validateFile(pdf(20 * 1024 * 1024 + 1), 'application/pdf', 'receipt'),
  ).rejects.toMatchObject({ code: 'invalid_file' });
  // The size cap is asserted before decoding, so an oversized photo fails on the cap alone.
  await expect(
    validateFile(Buffer.alloc(20 * 1024 * 1024 + 1), 'image/png', 'photo'),
  ).rejects.toMatchObject({ code: 'invalid_file' });
  // Under 20 MB a photo clears the size gate and only fails later, on decoding the filler.
  await expect(
    validateFile(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png', 'photo'),
  ).rejects.toMatchObject({ message: 'The image could not be decoded' });
  await expect(
    validateFile(Buffer.alloc(6 * 1024 * 1024), 'application/pdf', 'logo'),
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

it('stores receipts and photos on disk, signs short-lived links, and refuses traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ronb-storage-'));
  try {
    const c = config({ ...base, STORAGE_DIR: root });
    const storage = localStorage(c);
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    // Keys keep the same "<folder>/<uuid>.<ext>" shape object storage used, so the
    // database needs no migration when the directory is switched on.
    const photo = await storage.put('photo', bytes, 'image/png');
    expect(photo.key).toMatch(/^player-photos\/[0-9a-f-]{36}\.png$/);
    expect(await readFile(join(root, photo.key))).toEqual(bytes);
    const stored = await storage.read!('photo', photo.key);
    expect(stored?.mime).toBe('image/png');
    expect(stored?.body).toEqual(bytes);
    expect(await storage.read!('photo', 'player-photos/missing.png')).toBeUndefined();

    const pdf = await storage.put('receipt', Buffer.from('%PDF-1.7\n'), 'application/pdf');
    expect(pdf.key).toMatch(/^receipts\/[0-9a-f-]{36}\.pdf$/);

    const url = new URL(await storage.signPlayerPhoto(photo.key), c.APP_ORIGIN);
    expect(url.pathname).toBe(`/files/photo/${photo.key}`);
    const expires = Number(url.searchParams.get('expires'));
    const token = url.searchParams.get('token')!;
    expect(expires).toBeGreaterThan(Date.now());
    expect(fileTokenValid(c, 'photo', photo.key, expires, token)).toBe(true);
    expect(fileTokenValid(c, 'photo', photo.key, expires, 'x'.repeat(token.length))).toBe(false);
    expect(fileTokenValid(c, 'receipt', photo.key, expires, token)).toBe(false);
    expect(fileTokenValid(c, 'photo', photo.key, expires - 600_000, token)).toBe(false);
    expect(fileToken(c, 'photo', photo.key, expires)).toBe(token);

    // A traversal attempt is refused even though the string starts with a valid folder.
    // read() reports a missing file as undefined, so the guard is asserted on remove().
    for (const [kind, key] of [
      ['photo', 'player-photos/../../escape.png'],
      ['photo', 'player-photos/../receipts/x.png'],
      ['photo', 'player-photos/nested/x.png'],
      ['photo', '/etc/passwd'],
      ['receipt', 'receipts/../../escape.pdf'],
      ['receipt', 'player-photos/x.pdf'],
    ] as const) {
      await expect(storage.remove(kind, key)).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(storage.read!(kind, key)).rejects.toMatchObject({ code: 'invalid_key' });
    }

    await storage.remove('photo', photo.key);
    expect(await storage.read!('photo', photo.key)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('serves disk-backed files without touching object storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ronb-hybrid-'));
  try {
    // No S3 credentials at all: if the hybrid backend reached for object storage on a
    // locally stored file it would fail with storage_unconfigured instead of returning a link.
    const c = config({ ...base, STORAGE_DIR: root });
    const storage = hybridStorage(c);
    const stored = await storage.put('photo', Buffer.from([1, 2, 3]), 'image/png');
    expect(stored.key).toMatch(/^player-photos\//);
    expect(stored.url).toBe(stored.key);
    const url = new URL(await storage.signPlayerPhoto(stored.key), c.APP_ORIGIN);
    expect(url.pathname).toBe(`/files/photo/${stored.key}`);
    expect(
      fileTokenValid(
        c,
        'photo',
        stored.key,
        Number(url.searchParams.get('expires')),
        url.searchParams.get('token')!,
      ),
    ).toBe(true);
    expect((await storage.read!('photo', stored.key))?.body).toEqual(Buffer.from([1, 2, 3]));

    // A key that is not on disk falls back to object storage, which is unconfigured here.
    await expect(
      storage.signPlayerPhoto('player-photos/00000000-0000-0000-0000-000000000000.png'),
    ).rejects.toMatchObject({ code: 'storage_unconfigured' });
    expect(await storage.read!('photo', 'player-photos/missing.png')).toBeUndefined();

    // A malformed key is rejected outright rather than being sent to object storage.
    await expect(storage.signPlayerPhoto('player-photos/../../escape.png')).rejects.toMatchObject({
      code: 'invalid_key',
    });

    // Removing a file that was never written must not throw.
    await expect(
      storage.remove('photo', 'player-photos/00000000-0000-0000-0000-000000000000.png'),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('requires an absolute STORAGE_DIR and keeps logos on object storage', () => {
  expect(() => config({ ...base, STORAGE_DIR: 'relative/dir' })).toThrow('STORAGE_DIR');
  expect(config({ ...base }).STORAGE_DIR).toBe('');
  // Production still requires the logo bucket: logos stay remote even with STORAGE_DIR set.
  expect(() =>
    config({
      ...base,
      NODE_ENV: 'production',
      STORAGE_DIR: '/home/user/ronb-storage',
      S3_ENDPOINT: 'https://s3.example',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      RESEND_API_KEY: 'r',
      EMAIL_FROM: 'a@example.com',
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'gs',
    }),
  ).toThrow('S3_LOGOS_PUBLIC_URL');
  expect(() =>
    config({
      ...base,
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://ronb.example',
      STORAGE_DIR: '/home/user/ronb-storage',
      S3_ENDPOINT: 'https://s3.example',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_LOGOS_PUBLIC_URL: 'https://logos.example',
      RESEND_API_KEY: 'r',
      EMAIL_FROM: 'a@example.com',
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'gs',
    }),
  ).not.toThrow();
});
