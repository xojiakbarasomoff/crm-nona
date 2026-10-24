import type { Redis } from 'ioredis';
import type { PrismaClient } from '@crm/database';
import type { Role } from '@crm/domain';
import type { AppConfig } from './config';
import type { Adapters } from './adapters';
import type { Logger } from './logger';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface CoreDeps {
  prisma: PrismaClient;
  redis: Redis;
  config: AppConfig;
  adapters: Adapters;
  clock: Clock;
  logger: Logger;
  encryptionKey: Buffer;
}

export interface UserActor {
  type: 'user';
  id: string;
  companyId: string;
  role: Role;
  email: string;
  sessionId?: string;
  requestId?: string;
  ip?: string | null;
}

export interface SystemActor {
  type: 'system' | 'integration';
  id: null;
  companyId: string;
  name: string;
  requestId?: string;
}

export type Actor = UserActor | SystemActor;

export const systemActor = (companyId: string, name = 'system'): SystemActor => ({ type: 'system', id: null, companyId, name });
export const integrationActor = (companyId: string, name: string): SystemActor => ({ type: 'integration', id: null, companyId, name });
