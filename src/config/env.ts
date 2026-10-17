/**
 * The only place process.env is read. Everything is validated with Zod at
 * startup so a missing or malformed variable fails loudly before the server
 * accepts traffic, not at 7 pm when the first payment webhook arrives.
 *
 * Secrets are typed as `string` but never logged: the logger's redaction list
 * (observability/logger.ts) covers every key ending in TOKEN, SECRET or KEY.
 */
import 'dotenv/config';

import { z } from 'zod';

// Zod 4: .default() on a pipe expects the OUTPUT type, so default to false (boolean).
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .default(false);

const port = z.coerce.number().int().min(1).max(65535);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  APP_TIMEZONE: z.literal('Africa/Lagos').default('Africa/Lagos'),
  PORT: port.default(3000),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  DATABASE_URL_DIRECT: z.string().min(1),
  DATABASE_URL_MIGRATE: z.string().min(1).optional(),
  DATABASE_URL_TEST: z.string().min(1).optional(),
  /** Set to true when DATABASE_URL points at a transaction-mode pooler (prepared statements off). */
  DATABASE_POOLED: bool,

  INTERNAL_API_SECRET: z.string().min(32, 'use at least 32 random bytes (openssl rand -hex 32)'),

  TELEGRAM_CUSTOMER_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ADMIN_BOT_TOKEN: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
  /** Override for tests/mocks only. */
  TELEGRAM_API_BASE_URL: z.url().default('https://api.telegram.org'),

  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_PUBLIC_KEY: z.string().default(''),
  PAYSTACK_BASE_URL: z.url().default('https://api.paystack.co'),

  DELIVERY_PROVIDER: z.enum(['manual', 'kwik', 'mock']).default('manual'),
  KWIK_API_KEY: z.string().default(''),
  KWIK_BASE_URL: z.string().default(''),

  GEOCODER_PROVIDER: z.enum(['none', 'google', 'nominatim']).default('none'),
  GOOGLE_MAPS_API_KEY: z.string().default(''),

  AI_ENABLED: bool,
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'none']).default('none'),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),

  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),

  SENTRY_DSN: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse once, reuse. Throws a readable list of problems on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  // Refuse the two mistakes that cost real money.
  if (
    result.data.NODE_ENV !== 'production' &&
    result.data.PAYSTACK_SECRET_KEY.startsWith('sk_live_')
  ) {
    throw new Error('Refusing to start: a LIVE Paystack key is set outside production.');
  }
  if (source === process.env) cached = result.data;
  return result.data;
}

/** Test helper: forget the cached value. */
export function resetEnvCache(): void {
  cached = undefined;
}
