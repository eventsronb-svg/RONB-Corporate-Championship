import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Resend } from 'resend';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { Config } from './config.js';
import { assert, HttpError } from './errors.js';
export interface Identity {
  googleId: string;
  email: string;
  name: string;
}
export interface GoogleProvider {
  authorizationUrl(redirectUri: string, state: string, challenge: string): string;
  exchange(code: string, redirectUri: string, verifier: string): Promise<Identity>;
}
export interface StoredFile {
  key: string;
  url: string;
}
export type StoredFileKind = 'receipt' | 'logo' | 'photo';
export interface Storage {
  put(kind: StoredFileKind, buffer: Buffer, mime: string): Promise<StoredFile>;
  remove(kind: StoredFileKind, key: string): Promise<void>;
  signReceipt(key: string): Promise<string>;
  signPlayerPhoto(key: string): Promise<string>;
  // Object storage can hand out a presigned URL; the local backend cannot, so the
  // authenticated redirect route reads the bytes itself through the app instead.
  read?(kind: StoredFileKind, key: string): Promise<{ body: Buffer; mime: string } | undefined>;
}
export interface EmailPayload {
  to: string;
  userId: string;
  subject: string;
  text: string;
  html?: string;
}
export interface Mailer {
  send(payload: EmailPayload, idempotencyKey: string): Promise<string>;
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    public transient: boolean,
  ) {
    super(message);
  }
}
export function googleProvider(c: Config): GoogleProvider {
  const client = new OAuth2Client(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET);
  return {
    authorizationUrl(redirectUri, state, challenge) {
      assert(
        c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET,
        503,
        'google_unconfigured',
        'Google OAuth is not configured',
      );
      return client.generateAuthUrl({
        redirect_uri: redirectUri,
        scope: ['openid', 'email', 'profile'],
        state,
        code_challenge: challenge,
        code_challenge_method: CodeChallengeMethod.S256,
      });
    },
    async exchange(code, redirectUri, verifier) {
      try {
        const { tokens } = await client.getToken({
          code,
          redirect_uri: redirectUri,
          codeVerifier: verifier,
        });
        assert(tokens.id_token, 401, 'invalid_identity', 'Google did not return an identity token');
        const ticket = await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: c.GOOGLE_CLIENT_ID,
        });
        const p = ticket.getPayload();
        assert(
          p?.sub && p.email && p.email_verified,
          401,
          'invalid_identity',
          'A verified Google email is required',
        );
        return { googleId: p.sub, email: p.email.toLowerCase(), name: p.name ?? p.email };
      } catch {
        throw new HttpError(401, 'invalid_identity', 'Google sign-in could not be verified');
      }
    },
  };
}
// Player photos and receipts are accepted up to 20 MB so a captain can send a full-resolution
// photo and the client only compresses when the file is genuinely oversized. Logos stay small
// because they are publicly cached and displayed at a fixed size.
const MAX_FILE_BYTES: Record<StoredFileKind, number> = {
  photo: 20 * 1024 * 1024,
  receipt: 20 * 1024 * 1024,
  logo: 5 * 1024 * 1024,
};
export async function validateFile(buffer: Buffer, mime: string, kind: StoredFileKind) {
  const maxBytes = MAX_FILE_BYTES[kind];
  assert(
    buffer.length > 0 && buffer.length <= maxBytes,
    400,
    'invalid_file',
    `Files must be between 1 byte and ${Math.round(maxBytes / 1024 / 1024)} MB`,
  );
  if (
    kind === 'receipt' &&
    mime === 'application/pdf' &&
    buffer.subarray(0, 5).toString() === '%PDF-'
  )
    return { buffer, mime };
  assert(
    ['image/jpeg', 'image/png', 'image/webp'].includes(mime),
    400,
    'invalid_file',
    'Use PNG, JPEG or WebP; receipts also accept PDF',
  );
  try {
    // Uploads are bounded by file size; player photos keep their original dimensions.
    // sharp's built-in pixel guard still blocks decompression bombs.
    const img = sharp(buffer, { failOn: 'warning' });
    const info = await img.metadata();
    assert(
      ['jpeg', 'png', 'webp'].includes(info.format ?? ''),
      400,
      'invalid_file',
      'Unsupported image',
    );
    if (mime === 'image/webp') return { buffer, mime };
    // Preserve displayed dimensions and aspect ratio, applying EXIF orientation
    // before stripping metadata. Compress without cropping or resizing.
    const normalized = img.rotate();
    return {
      buffer: await normalized
        .webp({ quality: 50, alphaQuality: 100, smartSubsample: true, effort: 4 })
        .toBuffer(),
      mime: 'image/webp',
    };
  } catch {
    throw new HttpError(400, 'invalid_file', 'The image could not be decoded');
  }
}
export function s3Storage(c: Config): Storage {
  const client = new S3Client({
    endpoint: c.S3_ENDPOINT || undefined,
    region: c.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY },
    requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 },
    maxAttempts: 2,
  });
  const bucket = (kind: string) =>
    kind === 'receipt'
      ? c.S3_RECEIPTS_BUCKET
      : kind === 'photo'
        ? c.S3_PLAYERPHOTOS_BUCKET
        : c.S3_LOGOS_BUCKET;
  const prefix = (kind: string) =>
    kind === 'receipt' ? 'receipts' : kind === 'photo' ? 'player-photos' : 'team-logos';
  function ready() {
    assert(
      c.S3_ENDPOINT && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY,
      503,
      'storage_unconfigured',
      'Object storage is not configured',
    );
  }
  return {
    async put(kind, buffer, mime) {
      ready();
      if (kind === 'logo')
        assert(
          c.S3_LOGOS_PUBLIC_URL,
          503,
          'storage_unconfigured',
          'A public URL for this object kind is not configured',
        );
      const extension = {
        'application/pdf': 'pdf',
        'image/webp': 'webp',
        'image/png': 'png',
        'image/jpeg': 'jpg',
      }[mime];
      assert(extension, 400, 'invalid_file', 'Unsupported storage content type');
      const key = `${prefix(kind)}/${randomUUID()}.${extension}`;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket(kind),
          Key: key,
          Body: buffer,
          ContentType: mime,
          CacheControl:
            kind === 'logo' ? 'public, max-age=31536000, immutable' : 'private, no-store',
        }),
      );
      return {
        key,
        url: kind === 'logo' ? `${c.S3_LOGOS_PUBLIC_URL.replace(/\/$/, '')}/${key}` : key,
      };
    },
    async remove(kind, key) {
      ready();
      await client.send(new DeleteObjectCommand({ Bucket: bucket(kind), Key: key }));
    },
    async signReceipt(key) {
      ready();
      assert(key.startsWith('receipts/'), 400, 'invalid_key', 'Invalid receipt key');
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: c.S3_RECEIPTS_BUCKET,
          Key: key,
          ResponseContentDisposition: 'inline',
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn: 300 },
      );
    },
    async signPlayerPhoto(key) {
      ready();
      assert(key.startsWith('player-photos/'), 400, 'invalid_key', 'Invalid player photo key');
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: c.S3_PLAYERPHOTOS_BUCKET,
          Key: key,
          ResponseContentDisposition: 'inline',
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn: 300 },
      );
    },
  };
}
const DISK_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
// One folder plus one generated filename. No separators in the name, so a key can never
// climb out of its folder; the resolved-path check below repeats the guarantee.
const KEY_PATTERN = /^[a-z-]+\/[A-Za-z0-9._-]+$/;
const folderFor = (kind: StoredFileKind) =>
  kind === 'receipt' ? 'receipts' : kind === 'photo' ? 'player-photos' : 'team-logos';
const EXTENSION_FOR: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
function localPath(root: string, kind: StoredFileKind, key: string) {
  assert(key.length <= 120 && KEY_PATTERN.test(key), 400, 'invalid_key', 'Invalid file key');
  assert(key.startsWith(`${folderFor(kind)}/`), 400, 'invalid_key', 'Invalid file key');
  const full = resolve(root, key);
  // Defence in depth: the resolved path must still sit inside the storage root.
  const inside = relative(root, full);
  assert(
    inside && !inside.startsWith('..') && !inside.includes(`..${sep}`),
    400,
    'invalid_key',
    'Invalid file key',
  );
  return full;
}
// A short-lived signed link, matching the 300 s expiry of the presigned URLs it replaces.
export function fileToken(c: Config, kind: StoredFileKind, key: string, expires: number) {
  return createHmac('sha256', c.COOKIE_SECRET).update(`${kind}:${key}:${expires}`).digest('hex');
}
export function fileTokenValid(
  c: Config,
  kind: StoredFileKind,
  key: string,
  expires: number,
  token: string,
) {
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return false;
  const expected = Buffer.from(fileToken(c, kind, key, expires));
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
export function localStorage(c: Config): Storage {
  const root = resolve(c.STORAGE_DIR || 'storage');
  const signUrl = (kind: StoredFileKind, key: string) => {
    localPath(root, kind, key);
    const expires = Date.now() + 300_000;
    const token = fileToken(c, kind, key, expires);
    return `/files/${kind}/${key}?expires=${expires}&token=${token}`;
  };
  return {
    async put(kind, buffer, mime) {
      const extension = EXTENSION_FOR[mime];
      assert(extension, 400, 'invalid_file', 'Unsupported storage content type');
      const key = `${folderFor(kind)}/${randomUUID()}.${extension}`;
      const full = localPath(root, kind, key);
      await mkdir(dirname(full), { recursive: true });
      // Write beside the target and rename, so a reader never observes a partial upload.
      const temporary = `${full}.${randomUUID()}.tmp`;
      await writeFile(temporary, buffer);
      try {
        await rename(temporary, full);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return { key, url: key };
    },
    async remove(kind, key) {
      await rm(localPath(root, kind, key), { force: true });
    },
    signReceipt(key) {
      return Promise.resolve(signUrl('receipt', key));
    },
    signPlayerPhoto(key) {
      return Promise.resolve(signUrl('photo', key));
    },
    async read(kind, key) {
      const mime = DISK_MIME[extname(key).toLowerCase()];
      assert(mime, 400, 'invalid_key', 'Unsupported stored file type');
      try {
        return { body: await readFile(localPath(root, kind, key)), mime };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
  };
}
// Logos stay on object storage: they are the only publicly cached, high-traffic kind.
// Receipts and player photos go to STORAGE_DIR when it is set, and anything already in the
// bucket keeps resolving there so switching the directory on does not orphan existing files.
export function hybridStorage(c: Config): Storage {
  const remote = s3Storage(c);
  if (!c.STORAGE_DIR) return remote;
  const local = localStorage(c);
  // Choose a backend before signing rather than after: signing eagerly would hit S3 on every
  // local read, and probing with read() would buffer the whole file just to test for existence.
  const pick = async (kind: StoredFileKind, key: string) => {
    try {
      await access(localPath(resolve(c.STORAGE_DIR || 'storage'), kind, key));
      return local;
    } catch (error) {
      // A malformed key is a client error, not a reason to fall back to object storage.
      if (error instanceof HttpError) throw error;
      return remote;
    }
  };
  return {
    put: (kind, buffer, mime) =>
      kind === 'logo' ? remote.put(kind, buffer, mime) : local.put(kind, buffer, mime),
    remove: (kind, key) => (kind === 'logo' ? remote.remove(kind, key) : local.remove(kind, key)),
    async signReceipt(key) {
      return (await pick('receipt', key)).signReceipt(key);
    },
    async signPlayerPhoto(key) {
      return (await pick('photo', key)).signPlayerPhoto(key);
    },
    async read(kind, key) {
      return (await pick(kind, key)) === local ? local.read!(kind, key) : undefined;
    },
  };
}
export function resendMailer(c: Config): Mailer {
  class TimedResend extends Resend {
    override fetchRequest<T>(path: string, options: object = {}) {
      return super.fetchRequest<T>(path, { ...options, signal: AbortSignal.timeout(15000) });
    }
  }
  const client = new TimedResend(c.RESEND_API_KEY || 'unconfigured');
  return {
    async send(payload, key) {
      if (!c.RESEND_API_KEY || !c.EMAIL_FROM)
        throw new DeliveryError('Email is not configured', false);
      try {
        const { data, error } = await client.emails.send(
          {
            from: c.EMAIL_FROM,
            to: payload.to,
            subject: payload.subject,
            text: payload.text,
            html: payload.html,
          },
          { idempotencyKey: key },
        );
        if (error)
          throw new DeliveryError(
            error.message,
            error.statusCode === 429 ||
              (error.statusCode ?? 0) >= 500 ||
              error.name === 'concurrent_idempotent_requests' ||
              error.name === 'application_error' ||
              error.name === 'internal_server_error',
          );
        if (!data?.id) throw new DeliveryError('Provider returned no message id', true);
        return data.id;
      } catch (e) {
        if (e instanceof DeliveryError) throw e;
        throw new DeliveryError('Email provider connection failed', true);
      }
    },
  };
}
