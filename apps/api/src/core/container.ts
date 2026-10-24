import { Redis } from 'ioredis';
import { createPrisma, loadEncryptionKey, type PrismaClient } from '@crm/database';
import type { FetchLike } from '@crm/integrations';
import { buildAdapters } from './adapters';
import type { AppConfig } from './config';
import { systemClock, type Clock, type CoreDeps } from './context';
import { createLogger, type Logger } from './logger';
import { AdminService } from './services/admin.service';
import { AuthService } from './services/auth.service';
import { DashboardService } from './services/dashboard.service';
import { IntakeService } from './services/intake.service';
import { LeadsService } from './services/leads.service';
import { OAuthService } from './services/oauth.service';
import { OrdersService } from './services/orders.service';
import { ProcessingService } from './services/processing.service';
import { RemindersService } from './services/reminders.service';
import { SegmentsService } from './services/segments.service';
import { WebhooksService } from './services/webhooks.service';

export interface Core {
  deps: CoreDeps;
  auth: AuthService;
  leads: LeadsService;
  orders: OrdersService;
  segments: SegmentsService;
  reminders: RemindersService;
  intake: IntakeService;
  processing: ProcessingService;
  oauth: OAuthService;
  dashboard: DashboardService;
  webhooks: WebhooksService;
  admin: AdminService;
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
  const deps: CoreDeps = { prisma, redis, config, adapters, clock: o.clock ?? systemClock, logger, encryptionKey: loadEncryptionKey(config.encryptionKey) };
  oauth = new OAuthService(deps, o.fetchImpl);
  return {
    deps,
    auth: new AuthService(deps),
    leads: new LeadsService(deps),
    orders: new OrdersService(deps),
    segments: new SegmentsService(deps),
    reminders: new RemindersService(deps),
    intake: new IntakeService(deps),
    processing: new ProcessingService(deps),
    oauth,
    dashboard: new DashboardService(deps),
    webhooks: new WebhooksService(deps),
    admin: new AdminService(deps),
    async close() {
      if (!o.prisma) await prisma.$disconnect();
      if (!o.redis) redis.disconnect();
    },
  };
}
