import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  CORS_ORIGINS: z.string().default('*'),

  // Firebase Admin SDK — paste the entire service-account JSON as a single
  // env var (no file required). Optional so the server still boots in envs
  // without FCM configured; notification calls become no-ops in that case.
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // ── Google Play Developer API (subscription verification) ────────────────────
  // The Android application id whose subscriptions we verify. MUST match the
  // Play Console app + the Flutter `applicationId` (com.hk.settlio) — a
  // mismatch makes every purchases.subscriptionsv2.get 404 → verify fails.
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  // Full service-account JSON (single env var, mirrors FIREBASE_SERVICE_ACCOUNT_JSON).
  // The account needs the "View financial data / Manage orders" permission in
  // Play Console. Optional so the server still boots without it — but the verify
  // endpoint then fails CLOSED (it never fake-grants).
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Shared secret guarding the RTDN webhook. Append it to the Pub/Sub push
  // endpoint as `?token=…` (or send it as the `x-rtdn-token` header). When set,
  // the webhook rejects any request without a matching token. When UNSET, the
  // webhook is rejected in production and allowed (with a warning) elsewhere so
  // local/staging testing works without a secret.
  RTDN_VERIFICATION_TOKEN: z.string().optional(),

  // Whether monetization is REQUIRED for this deployment. When required and the
  // Google Play / RTDN secrets are missing, the server FAILS FAST at startup
  // (rather than silently running a broken billing surface). Tri-state: unset →
  // defaults to "required in production only". Set `false` to run without
  // billing (e.g. a staging API that doesn't exercise purchases).
  MONETIZATION_REQUIRED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // ── Feature flags ────────────────────────────────────────────────────────────
  // Gate all non-EQUAL split types (EXACT / PERCENT / SHARES). Set to 'true'
  // only after the matching frontend build is in production. Old clients never
  // send splitType at all, so they are unaffected regardless of this flag.
  FEATURE_SPLIT_TYPES_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Readonly<Env> = Object.freeze(parsed.data);

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
