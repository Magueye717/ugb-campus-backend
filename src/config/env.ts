import { Type } from 'typebox';
import { Value } from 'typebox/value';

const Bool = Type.Union([Type.Boolean(), Type.Literal('true'), Type.Literal('false')], { default: false });

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')], { default: 'development' }),
  HOST: Type.String({ default: '0.0.0.0' }),
  PORT: Type.Number({ default: 3000 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  // "Aide & support" in the app: who students call, message or write to.
  SUPPORT_PHONE: Type.String({ default: '777902880' }),
  SUPPORT_EMAIL: Type.String({ default: 'ugb.campus@gmail.com' }),
  /** Behind a reverse proxy: trust X-Forwarded-For so rate limits see the real client IP. */
  TRUST_PROXY: Bool,
  /**
   * Browser origins allowed to call the API (comma-separated). The mobile app doesn't need CORS; this is for the
   * Expo web build in development and a future admin web app. Empty = CORS closed.
   */
  CORS_ORIGINS: Type.String({ default: '' }),
  /** Swagger UI on /docs: the temporary back office (decision Q-12). */
  DOCS_ENABLED: Bool,

  MONGODB_URI: Type.String({ default: 'mongodb://localhost:27018/?replicaSet=rs0' }),
  MONGODB_DB: Type.String({ default: 'ugb_campus' }),
  REDIS_URL: Type.String({ default: 'redis://localhost:6379' }),
  /** Namespaces Redis keys and BullMQ queues (tests use one per file). */
  REDIS_PREFIX: Type.String({ default: 'ugb' }),

  /** Ed25519 keys, PEM (PKCS#8 / SPKI), base64-encoded so they fit on one line. `npm run keys` generates them. */
  JWT_PRIVATE_KEY_B64: Type.Optional(Type.String()),
  JWT_PUBLIC_KEY_B64: Type.Optional(Type.String()),
  JWT_KID: Type.String({ default: 'dev-1' }),
  ACCESS_TOKEN_TTL_S: Type.Number({ default: 900 }),
  REFRESH_TOKEN_TTL_DAYS: Type.Number({ default: 30 }),
  REFRESH_TOKEN_ABSOLUTE_DAYS: Type.Number({ default: 90 }),

  /** Multiplies every rate limit. Tests raise it (one IP for everything); production must keep 1. */
  RATE_LIMIT_SCALE: Type.Number({ default: 1, minimum: 1 }),

  /** HMAC pepper for OTP codes. */
  OTP_PEPPER: Type.Optional(Type.String({ minLength: 32 })),
  OTP_LENGTH: Type.Number({ default: 4, minimum: 4, maximum: 8 }),
  /** Development only: fixed code (1234…), logged instead of sent. Refused in production. */
  OTP_DEV_MODE: Bool,
  /** `console` logs SMS (development); real providers are added once chosen (Q-14). */
  SMS_PROVIDER: Type.Union([Type.Literal('console')], { default: 'console' }),

  /**
   * Development only: Wave and Orange Money are simulated (checkout page + signed webhooks through the real code
   * path). Refused in production. Real adapters arrive with the merchant accounts (Q-1).
   */
  PAYMENTS_SIMULATOR: Bool,
  /** HMAC secret of the simulated provider's webhooks. */
  SIMULATOR_WEBHOOK_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  /**
   * Public base URL of the API (e.g. https://api.ugb-campus.sn), used in checkout links. Without it, the host the
   * app called is used, which is what a phone on the same Wi-Fi needs in development.
   */
  PUBLIC_API_URL: Type.Optional(Type.String({ pattern: '^https?://[^/]+$' })),

  /**
   * Push notifications: `expo` sends through Expo's push service (phones register their Expo push token);
   * `log` only writes them to the worker log (tests, machines without internet).
   */
  PUSH_PROVIDER: Type.Union([Type.Literal('expo'), Type.Literal('log')], { default: 'log' }),
  /** Optional: Expo access token, if "enhanced push security" is on for the project. */
  EXPO_ACCESS_TOKEN: Type.Optional(Type.String()),

  /**
   * Uploaded images (banners, events): `local` writes them under MEDIA_DIR and serves them from /media
   * (development); `s3` puts them in an S3-compatible bucket (AWS S3, Cloudflare R2). Production requires `s3`.
   */
  MEDIA_STORAGE: Type.Union([Type.Literal('local'), Type.Literal('s3')], { default: 'local' }),
  MEDIA_DIR: Type.String({ default: './var/media' }),
  /** Lost student cards are read by OCR (Tesseract): its French language data is downloaded once into this folder. */
  OCR_CACHE_DIR: Type.String({ default: './var/ocr' }),
  /** Public base URL of the stored files (CDN or bucket domain), e.g. https://media.ugb-campus.sn. Local: the API's /media. */
  MEDIA_PUBLIC_URL: Type.Optional(Type.String({ pattern: '^https?://' })),
  S3_BUCKET: Type.Optional(Type.String()),
  S3_REGION: Type.String({ default: 'auto' }),
  /** R2 or another S3-compatible service; empty for AWS. */
  S3_ENDPOINT: Type.Optional(Type.String({ pattern: '^https?://' })),
  S3_ACCESS_KEY_ID: Type.Optional(Type.String()),
  S3_SECRET_ACCESS_KEY: Type.Optional(Type.String()),
});

type RawEnv = Type.Static<typeof EnvSchema>;

export type Config = Omit<RawEnv, 'TRUST_PROXY' | 'DOCS_ENABLED' | 'OTP_DEV_MODE' | 'PAYMENTS_SIMULATOR' | 'SIMULATOR_WEBHOOK_SECRET' | 'JWT_PRIVATE_KEY_B64' | 'JWT_PUBLIC_KEY_B64' | 'OTP_PEPPER'> & {
  TRUST_PROXY: boolean;
  DOCS_ENABLED: boolean;
  OTP_DEV_MODE: boolean;
  PAYMENTS_SIMULATOR: boolean;
  SIMULATOR_WEBHOOK_SECRET: string;
  jwt: { privateKeyPem?: string; publicKeyPem?: string };
  OTP_PEPPER: string;
  isProduction: boolean;
};

const toBool = (v: boolean | string) => v === true || v === 'true';
const decode = (b64?: string) => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined);

const DEV_PEPPER = 'dev-only-otp-pepper-change-me-0123456789';
const DEV_SIMULATOR_SECRET = 'dev-only-payment-simulator-secret-0123456789';

/** Reads and validates the environment once. Throws on anything invalid or unsafe for production. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const input = Object.fromEntries(Object.entries(env).filter(([k, v]) => k in EnvSchema.properties && v !== '' && v !== undefined));
  const candidate = Value.Default(EnvSchema, Value.Convert(EnvSchema, input));
  if (!Value.Check(EnvSchema, candidate)) {
    // Field names and rules only: values may be secrets (keys, pepper) and must never reach the logs.
    const problems = Value.Errors(EnvSchema, candidate).map((e) => `${e.instancePath.slice(1) || '(root)'} ${e.message}`);
    throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  }
  const raw = candidate;
  const isProduction = raw.NODE_ENV === 'production';
  const config: Config = {
    ...raw,
    TRUST_PROXY: toBool(raw.TRUST_PROXY),
    DOCS_ENABLED: toBool(raw.DOCS_ENABLED),
    OTP_DEV_MODE: toBool(raw.OTP_DEV_MODE),
    PAYMENTS_SIMULATOR: toBool(raw.PAYMENTS_SIMULATOR),
    SIMULATOR_WEBHOOK_SECRET: raw.SIMULATOR_WEBHOOK_SECRET ?? DEV_SIMULATOR_SECRET,
    jwt: { privateKeyPem: decode(raw.JWT_PRIVATE_KEY_B64), publicKeyPem: decode(raw.JWT_PUBLIC_KEY_B64) },
    OTP_PEPPER: raw.OTP_PEPPER ?? DEV_PEPPER,
    isProduction,
    ...overrides,
  };
  assertProductionSafety(config);
  return config;
}

/** Development conveniences must never reach production: refuse to boot instead. */
function assertProductionSafety(c: Config) {
  if (!c.isProduction) return;
  const problems: string[] = [];
  if (c.OTP_DEV_MODE) problems.push('OTP_DEV_MODE must be false');
  if (c.MEDIA_STORAGE !== 's3') problems.push('MEDIA_STORAGE must be s3');
  if (c.MEDIA_STORAGE === 's3' && (!c.S3_BUCKET || !c.MEDIA_PUBLIC_URL || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) problems.push('S3_BUCKET, MEDIA_PUBLIC_URL and S3 keys must be set');
  if (c.OTP_PEPPER === DEV_PEPPER) problems.push('OTP_PEPPER must be set');
  if (!c.jwt.privateKeyPem || !c.jwt.publicKeyPem) problems.push('JWT keys must be set');
  if (c.SMS_PROVIDER === 'console') problems.push('a real SMS_PROVIDER is required');
  if (c.RATE_LIMIT_SCALE !== 1) problems.push('RATE_LIMIT_SCALE must be 1');
  if (c.PAYMENTS_SIMULATOR) problems.push('PAYMENTS_SIMULATOR must be false');
  if (c.PUSH_PROVIDER === 'log') problems.push('PUSH_PROVIDER must be expo');
  if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
}
