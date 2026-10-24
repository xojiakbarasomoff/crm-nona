import { z } from 'zod';
import { parseAppMode, type AppMode } from '@crm/integrations';

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));
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
  AMO_CLIENT_ID: z.string().default(''),
  AMO_CLIENT_SECRET: z.string().default(''),
  AMO_REDIRECT_URI: z.string().default(''),
  AMO_ALLOWED_DOMAINS: csv,
  AMO_RATE_LIMIT_RPS: z.coerce.number().default(5),
  AMO_CHAT_CHANNEL_ID: z.string().default(''),
  AMO_CHAT_SECRET: z.string().default(''),
  AMO_CHAT_BOT_NAME: z.string().default('Instagram Direct'),
  DIRECT_CHANNEL_MODE: z.enum(['native_connector', 'custom_channel']).default('custom_channel'),
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  META_GRAPH_VERSION: z.string().default(''),
  META_DIRECT_LOGIN: z.enum(['instagram_login', 'facebook_login']).default('instagram_login'),
  META_STANDARD_WINDOW_HOURS: z.coerce.number().default(24),
  META_HUMAN_AGENT_WINDOW_HOURS: optionalNumber,
  META_HUMAN_AGENT_GRANTED: z.string().default('false'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(10 * 1024 * 1024),
  SCHEDULER_INTERVAL_MS: z.coerce.number().default(15_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().default(1_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().default(300_000),
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
  amo: { clientId: string; clientSecret: string; redirectUri: string; allowedDomains: string[]; rps: number };
  amoChats: { channelId: string; secret: string; botName: string };
  directChannelMode: 'native_connector' | 'custom_channel';
  meta: {
    appId: string;
    appSecret: string;
    verifyToken: string;
    graphVersion: string;
    directLogin: 'instagram_login' | 'facebook_login';
    standardWindowHours: number;
    humanAgentWindowHours: number | null;
    humanAgentGranted: boolean;
  };
  storageDir: string;
  maxUploadBytes: number;
  schedulerIntervalMs: number;
  outboxIntervalMs: number;
  reconcileIntervalMs: number;
  metricsToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = schema.parse(env);
  const mode = parseAppMode(e.APP_MODE);
  const cookieSecure = e.COOKIE_SECURE !== 'false';
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
    amo: { clientId: e.AMO_CLIENT_ID, clientSecret: e.AMO_CLIENT_SECRET, redirectUri: e.AMO_REDIRECT_URI, allowedDomains: e.AMO_ALLOWED_DOMAINS, rps: e.AMO_RATE_LIMIT_RPS },
    amoChats: { channelId: e.AMO_CHAT_CHANNEL_ID, secret: e.AMO_CHAT_SECRET, botName: e.AMO_CHAT_BOT_NAME },
    directChannelMode: e.DIRECT_CHANNEL_MODE,
    meta: {
      appId: e.META_APP_ID,
      appSecret: e.META_APP_SECRET,
      verifyToken: e.META_VERIFY_TOKEN,
      graphVersion: e.META_GRAPH_VERSION,
      directLogin: e.META_DIRECT_LOGIN,
      standardWindowHours: e.META_STANDARD_WINDOW_HOURS,
      humanAgentWindowHours: e.META_HUMAN_AGENT_WINDOW_HOURS,
      humanAgentGranted: e.META_HUMAN_AGENT_GRANTED === 'true',
    },
    storageDir: e.STORAGE_LOCAL_DIR,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    schedulerIntervalMs: Math.min(e.SCHEDULER_INTERVAL_MS, 30_000),
    outboxIntervalMs: e.OUTBOX_INTERVAL_MS,
    reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
    metricsToken: e.METRICS_TOKEN,
  };
}
