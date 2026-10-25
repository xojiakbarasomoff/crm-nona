import { z } from 'zod';
import { parseAppMode, type AppMode } from '@crm/integrations';

const optionalNumber = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : Number(v)));

const schema = z.object({
  APP_MODE: z.string(),
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(4100),
  APP_PUBLIC_URL: z.string().default('http://localhost:3100'),
  API_PUBLIC_URL: z.string().default('http://localhost:4100'),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(40),
  COOKIE_SECURE: z.string().default('true'),
  /** Demo-only: login by short name (admin/user1/user2), simple passwords, no admin MFA. Rejected outside demo mode. */
  DEMO_SIMPLE_LOGIN: z.string().default('false'),
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  META_GRAPH_VERSION: z.string().default(''),
  META_DIRECT_LOGIN: z.enum(['instagram_login', 'facebook_login']).default('instagram_login'),
  /** Instagram API with Instagram Login: Instagram app id/secret (App Dashboard → Instagram → API setup with Instagram login). */
  INSTAGRAM_APP_ID: z.string().default(''),
  INSTAGRAM_APP_SECRET: z.string().default(''),
  /** Default: <APP_PUBLIC_URL>/api/v1/integrations/instagram/oauth/callback */
  INSTAGRAM_REDIRECT_URI: z.string().default(''),
  META_STANDARD_WINDOW_HOURS: z.coerce.number().default(24),
  META_HUMAN_AGENT_WINDOW_HOURS: optionalNumber,
  META_HUMAN_AGENT_GRANTED: z.string().default('false'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z
    .string()
    .default('')
    .transform((v) => v || 'us-east-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z.string().default('true'),
  S3_SSE: z.enum(['', 'AES256', 'aws:kms']).default(''),
  SCANNER: z.enum(['builtin', 'clamav']).default('builtin'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().default(3310),
  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().min(30).max(3600).default(300),
  SLA_WARN_MINUTES: z.coerce.number().min(1).max(120).default(5),
  META_LEADS_RETENTION_DAYS: z.coerce.number().min(1).max(3650).default(90),
  MAX_UPLOAD_BYTES: z.coerce.number().default(10 * 1024 * 1024),
  SCHEDULER_INTERVAL_MS: z.coerce.number().default(15_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().default(1_000),
  METRICS_TOKEN: z.string().default(''),
});

export interface AppConfig {
  mode: AppMode;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  apiPort: number;
  appPublicUrl: string;
  apiPublicUrl: string;
  sessionSecret: string;
  encryptionKey: string;
  cookieSecure: boolean;
  demoSimpleLogin: boolean;
  meta: {
    appId: string;
    appSecret: string;
    verifyToken: string;
    graphVersion: string;
    directLogin: 'instagram_login' | 'facebook_login';
    instagram: { appId: string; appSecret: string; redirectUri: string };
    standardWindowHours: number;
    humanAgentWindowHours: number | null;
    humanAgentGranted: boolean;
  };
  storageDir: string;
  storage: { driver: 'local' | 's3'; s3: { endpoint: string | null; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean; serverSideEncryption: 'AES256' | 'aws:kms' | null } };
  scanner: { kind: 'builtin' | 'clamav'; host: string; port: number };
  downloadUrlTtlSeconds: number;
  slaWarnMinutes: number;
  metaLeadsRetentionDays: number;
  maxUploadBytes: number;
  schedulerIntervalMs: number;
  outboxIntervalMs: number;
  metricsToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = schema.parse(env);
  const mode = parseAppMode(e.APP_MODE);
  const cookieSecure = e.COOKIE_SECURE !== 'false';
  const demoSimpleLogin = e.DEMO_SIMPLE_LOGIN === 'true' || e.DEMO_SIMPLE_LOGIN === '1';
  if (demoSimpleLogin && mode !== 'demo') throw new Error('DEMO_SIMPLE_LOGIN is only allowed in demo mode');
  if (mode !== 'demo' && !cookieSecure) throw new Error('COOKIE_SECURE=false is only allowed in demo mode');
  if (mode !== 'demo' && e.SESSION_SECRET.startsWith('change-me')) throw new Error('SESSION_SECRET must be set outside demo mode');
  return {
    mode,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    apiPort: e.API_PORT,
    appPublicUrl: e.APP_PUBLIC_URL,
    apiPublicUrl: e.API_PUBLIC_URL,
    sessionSecret: e.SESSION_SECRET,
    encryptionKey: e.ENCRYPTION_KEY,
    cookieSecure,
    demoSimpleLogin,
    meta: {
      appId: e.META_APP_ID,
      appSecret: e.META_APP_SECRET,
      verifyToken: e.META_VERIFY_TOKEN,
      graphVersion: e.META_GRAPH_VERSION,
      directLogin: e.META_DIRECT_LOGIN,
      instagram: { appId: e.INSTAGRAM_APP_ID, appSecret: e.INSTAGRAM_APP_SECRET, redirectUri: e.INSTAGRAM_REDIRECT_URI || `${e.APP_PUBLIC_URL.replace(/\/$/, '')}/api/v1/integrations/instagram/oauth/callback` },
      standardWindowHours: e.META_STANDARD_WINDOW_HOURS,
      humanAgentWindowHours: e.META_HUMAN_AGENT_WINDOW_HOURS,
      humanAgentGranted: e.META_HUMAN_AGENT_GRANTED === 'true',
    },
    storageDir: e.STORAGE_LOCAL_DIR,
    storage: {
      driver: e.STORAGE_DRIVER,
      s3: {
        endpoint: e.S3_ENDPOINT || null,
        region: e.S3_REGION,
        bucket: e.S3_BUCKET,
        accessKeyId: e.S3_ACCESS_KEY_ID,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY,
        forcePathStyle: e.S3_FORCE_PATH_STYLE !== 'false',
        serverSideEncryption: e.S3_SSE || null,
      },
    },
    scanner: { kind: e.SCANNER, host: e.CLAMD_HOST, port: e.CLAMD_PORT },
    downloadUrlTtlSeconds: e.DOWNLOAD_URL_TTL_SECONDS,
    slaWarnMinutes: e.SLA_WARN_MINUTES,
    metaLeadsRetentionDays: e.META_LEADS_RETENTION_DAYS,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    schedulerIntervalMs: Math.min(e.SCHEDULER_INTERVAL_MS, 30_000),
    outboxIntervalMs: e.OUTBOX_INTERVAL_MS,
    metricsToken: e.METRICS_TOKEN,
  };
}
