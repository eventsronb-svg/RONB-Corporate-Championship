import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Resend } from 'resend';
import { randomUUID } from 'node:crypto';
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
export interface Storage {
  put(kind: 'receipt' | 'logo', buffer: Buffer, mime: string): Promise<StoredFile>;
  remove(kind: 'receipt' | 'logo', key: string): Promise<void>;
  signReceipt(key: string): Promise<string>;
}
export interface EmailPayload {
  to: string;
  userId: string;
  subject: string;
  text: string;
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
export async function validateFile(buffer: Buffer, mime: string, kind: 'receipt' | 'logo') {
  assert(
    buffer.length > 0 && buffer.length <= 5 * 1024 * 1024,
    400,
    'invalid_file',
    'Files must be between 1 byte and 5 MB',
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
    const img = sharp(buffer, { limitInputPixels: 20_000_000, failOn: 'warning' });
    const info = await img.metadata();
    assert(
      ['jpeg', 'png', 'webp'].includes(info.format ?? ''),
      400,
      'invalid_file',
      'Unsupported image',
    );
    // Preserve displayed dimensions and aspect ratio, applying EXIF orientation
    // before stripping metadata. Compress without cropping or resizing.
    const normalized = img.rotate();
    return {
      buffer: await normalized
        .webp({ quality: 90, alphaQuality: 100, smartSubsample: true, effort: 4 })
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
  const bucket = (kind: string) => (kind === 'receipt' ? c.S3_RECEIPTS_BUCKET : c.S3_LOGOS_BUCKET);
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
          'Public logo URL is not configured',
        );
      const extension = {
        'application/pdf': 'pdf',
        'image/webp': 'webp',
        'image/png': 'png',
        'image/jpeg': 'jpg',
      }[mime];
      assert(extension, 400, 'invalid_file', 'Unsupported storage content type');
      const key = `${kind === 'receipt' ? 'receipts' : 'team-logos'}/${randomUUID()}.${extension}`;
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
        url: kind === 'receipt' ? key : `${c.S3_LOGOS_PUBLIC_URL.replace(/\/$/, '')}/${key}`,
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
          { from: c.EMAIL_FROM, to: payload.to, subject: payload.subject, text: payload.text },
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
