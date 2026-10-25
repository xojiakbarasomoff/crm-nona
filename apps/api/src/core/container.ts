import { Redis } from 'ioredis';
import { createPrisma, loadEncryptionKey, type PrismaClient } from '@crm/database';
import type { FetchLike } from '@crm/integrations';
import { buildAdapters } from './adapters';
import type { AppConfig } from './config';
import { systemClock, type Clock, type CoreDeps } from './context';
import { createLogger, type Logger } from './logger';
import { AdminService } from './services/admin.service';
import { AttachmentsService } from './services/attachments.service';
import { SlaService } from './services/sla.service';
import { PrivacyService } from './services/privacy.service';
import { AmoSyncService } from './services/amo-sync.service';
import { LeadAdsBackfillService } from './services/lead-ads-backfill.service';
import { AuthService } from './services/auth.service';
import { DashboardService } from './services/dashboard.service';
import { IntakeService } from './services/intake.service';
import { LeadsService } from './services/leads.service';
import { OAuthService } from './services/oauth.service';
import { InstagramService } from './services/instagram.service';
import { InstagramProfileService } from './services/instagram-profile.service';
import { DemoCleanupService } from './services/demo-cleanup.service';
import { ManualLeadService } from './services/manual-lead.service';
import { OrdersService } from './services/orders.service';
import { ProcessingService } from './services/processing.service';
import { RemindersService } from './services/reminders.service';
import { SegmentsService } from './services/segments.service';
import { SuppliersService } from './services/suppliers.service';
import { WebhooksService } from './services/webhooks.service';

export interface Core {
  deps: CoreDeps;
  auth: AuthService;
  leads: LeadsService;
  orders: OrdersService;
  segments: SegmentsService;
  suppliers: SuppliersService;
  reminders: RemindersService;
  intake: IntakeService;
  processing: ProcessingService;
  oauth: OAuthService;
  instagram: InstagramService;
  instagramProfiles: InstagramProfileService;
  demoCleanup: DemoCleanupService;
  manualLeads: ManualLeadService;
  dashboard: DashboardService;
  webhooks: WebhooksService;
  admin: AdminService;
  attachments: AttachmentsService;
  sla: SlaService;
  privacy: PrivacyService;
  amoSync: AmoSyncService;
  leadAdsBackfill: LeadAdsBackfillService;
  close(): Promise<void>;
}

export interface CoreOverrides {
  prisma?: PrismaClient;
  redis?: Redis;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchLike;
}

export function createCore(config: AppConfig, o: CoreOverrides = {}): Core {
  const prisma = o.prisma ?? createPrisma(config.databaseUrl);
  const redis = o.redis ?? new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  redis.on('error', () => undefined);
  const logger = o.logger ?? createLogger(config.logLevel);
  let oauth: OAuthService | null = null;
  const adapters = buildAdapters(config, redis, (id) => oauth!.tokenProvider(id));
  const deps: CoreDeps = { prisma, redis, config, adapters, clock: o.clock ?? systemClock, logger, encryptionKey: loadEncryptionKey(config.encryptionKey), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) };
  oauth = new OAuthService(deps, o.fetchImpl);
  return {
    deps,
    auth: new AuthService(deps),
    leads: new LeadsService(deps),
    orders: new OrdersService(deps),
    segments: new SegmentsService(deps),
    suppliers: new SuppliersService(deps),
    reminders: new RemindersService(deps),
    intake: new IntakeService(deps),
    processing: new ProcessingService(deps),
    oauth,
    instagram: new InstagramService(deps, o.fetchImpl),
    instagramProfiles: new InstagramProfileService(deps),
    demoCleanup: new DemoCleanupService(deps),
    manualLeads: new ManualLeadService(deps),
    dashboard: new DashboardService(deps),
    webhooks: new WebhooksService(deps),
    admin: new AdminService(deps),
    attachments: new AttachmentsService(deps),
    sla: new SlaService(deps),
    privacy: new PrivacyService(deps),
    amoSync: new AmoSyncService(deps),
    leadAdsBackfill: new LeadAdsBackfillService(deps),
    async close() {
      if (!o.prisma) await prisma.$disconnect();
      if (!o.redis) redis.disconnect();
    },
  };
}

/**
 * Startup guard (TZ §25.1): outside demo mode the process refuses to start while demo accounts or
 * demo-mode connections exist in the database.
 */
export async function assertProductionSafety(core: Core): Promise<void> {
  if (core.deps.config.mode === 'demo') return;
  const demoUsers = await core.deps.prisma.user.count({ where: { email: { endsWith: '@demo.local' }, status: { not: 'blocked' } } });
  const demoConnections = await core.deps.prisma.integrationConnection.count({ where: { mode: 'demo', disconnectedAt: null } });
  if (demoUsers || demoConnections) {
    throw new Error(`Refusing to start in ${core.deps.config.mode}: ${demoUsers} demo account(s) and ${demoConnections} demo connection(s) present. Use a clean database.`);
  }
}
