import { z } from 'zod';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  ADMIN_LOGIN_USERNAME: z.string().default(''),
  ADMIN_LOGIN_PASSWORD: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_RECEIPTS_BUCKET: z.string().default('booking-private'),
  S3_LOGOS_BUCKET: z.string().default('booking-public'),
  S3_LOGOS_PUBLIC_URL: z.string().default(''),
  S3_PLAYERPHOTOS_BUCKET: z.string().default('player-photos'),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default(''),
  PAYMENT_BANK_DETAILS: z.string().max(4000).default(''),
  PAYMENT_INSTRUCTIONS: z
    .string()
    .default(
      'Transfer the exact amount to the bank account below and enter the payment code in payment remarks. Use the same code for every transfer from your account.',
    ),
  PAYMENT_EXPIRY_MINUTES: z.coerce.number().int().min(5).max(10080).default(1440),
});
export type Config = z.infer<typeof envSchema>;
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const c = envSchema.parse(env);
  if (Boolean(c.ADMIN_LOGIN_USERNAME) !== Boolean(c.ADMIN_LOGIN_PASSWORD))
    throw new Error('Set both ADMIN_LOGIN_USERNAME and ADMIN_LOGIN_PASSWORD, or leave both empty');
  if (c.ADMIN_LOGIN_PASSWORD && c.ADMIN_LOGIN_PASSWORD.length < 16)
    throw new Error('ADMIN_LOGIN_PASSWORD must contain at least 16 characters');
  if (new URL(c.APP_ORIGIN).origin !== c.APP_ORIGIN)
    throw new Error('APP_ORIGIN must be an origin without a trailing slash');
  if (
    !c.S3_RECEIPTS_BUCKET ||
    !c.S3_LOGOS_BUCKET ||
    !c.S3_PLAYERPHOTOS_BUCKET ||
    c.S3_RECEIPTS_BUCKET === c.S3_LOGOS_BUCKET ||
    c.S3_RECEIPTS_BUCKET === c.S3_PLAYERPHOTOS_BUCKET ||
    c.S3_LOGOS_BUCKET === c.S3_PLAYERPHOTOS_BUCKET
  )
    throw new Error('Receipt, logo and player-photo storage require distinct buckets');
  if (c.NODE_ENV === 'production') {
    for (const key of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_LOGOS_PUBLIC_URL',
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'PAYMENT_BANK_DETAILS',
    ] as const) {
      if (!c[key]) throw new Error(`${key} is required in production`);
    }
    if (!c.APP_ORIGIN.startsWith('https://') || !c.S3_LOGOS_PUBLIC_URL.startsWith('https://'))
      throw new Error('Production origins must use HTTPS');
  }
  return c;
}
