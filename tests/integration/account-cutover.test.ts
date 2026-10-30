import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { createPrisma } from '../../packages/database/src';
import { alwaysOnDuty, login, makeApp, makeCore, newLead } from './helpers';

/**
 * Переход на рабочие аккаунты. Используется ОТДЕЛЬНАЯ временная база (как в demo-cleanup.test.ts): закрытие демо-аккаунтов
 * не должно влиять на остальные тестовые файлы.
 */
const root = join(__dirname, '..', '..');
const tag = Date.now().toString(36);
const ACCOUNTS = [
  { login: `adm_${tag}`, fullName: 'Nozima Test', role: 'ADMIN' as const, password: 'nonatravel123' },
  { login: `mgr_${tag}`, fullName: 'Менеджер', role: 'MANAGER' as const, password: '12345' },
  { login: `usr_${tag}`, fullName: 'Пользователь', role: 'USER' as const, password: '12345' },
];

async function withDb(fn: (ctx: { core: Core; app: INestApplication }) => Promise<void>) {
  const base = process.env.TEST_DATABASE_URL!;
  const dbName = `crm_cutover_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  const adminDb = createPrisma(base);
  await adminDb.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  const env = { ...process.env, DATABASE_URL: url.toString(), APP_MODE: 'demo' };
  execSync('npx prisma migrate deploy', { cwd: root, env, stdio: 'pipe' });
  execSync('npx tsx --conditions=development packages/database/src/seed.ts', { cwd: root, env, stdio: 'pipe' });
  const core = makeCore({ env: { DATABASE_URL: url.toString() } });
  await alwaysOnDuty(core);
  const app = await makeApp(core);
  try {
    await fn({ core, app });
  } finally {
    await app.close();
    await core.close();
    await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminDb.$disconnect();
  }
}

describe('переход на рабочие аккаунты: закрытие старых демо-аккаунтов', () => {
  it('старые аккаунты блокируются, сессии отзываются, активные записи уходят администратору, история и копия сохраняются', () =>
    withDb(async ({ core, app }) => {
      const p = () => core.deps.prisma;
      await core.accounts.provision(ACCOUNTS);
      const oldMgr = await p().user.findUniqueOrThrow({ where: { email: 'menejer.a@demo.local' } });
      const oldHead = await p().user.findUniqueOrThrow({ where: { email: 'admin2@demo.local' } });
      const oldSession = await login(app, 'menejer.a@demo.local');
      const lead = await newLead(app, core);
      await p().lead.update({ where: { id: lead.id }, data: { ownerId: oldMgr.id } });
      const headLead = await newLead(app, core);
      await p().lead.update({ where: { id: headLead.id }, data: { ownerId: oldHead.id } });
      const closedLead = await newLead(app, core);
      await p().lead.update({ where: { id: closedLead.id }, data: { ownerId: oldMgr.id, stage: 'WON', closedAt: new Date(), firstWonAt: new Date() } });
      const auditBefore = await p().auditLog.count();
      const usersBefore = await p().user.count();

      const res = await core.accounts.closeLegacy();
      const nozima = await p().user.findUniqueOrThrow({ where: { login: ACCOUNTS[0]!.login } });
      expect(res.successor).toBe(ACCOUNTS[0]!.login);
      // старые аккаунты закрыты; настоящие остались активными; никого не удалили
      expect(await p().user.count({ where: { email: { endsWith: '@demo.local' }, status: { not: 'blocked' } } })).toBe(0);
      expect(await p().user.count({ where: { login: { in: ACCOUNTS.map((a) => a.login) }, status: 'active' } })).toBe(3);
      expect(await p().user.count()).toBe(usersBefore);
      // сессия закрыта сразу, вход старым аккаунтом невозможен
      expect((await oldSession.get('/api/v1/me')).status).toBe(401);
      const denied = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'menejer.a@demo.local', password: 'any' });
      expect(denied.status).toBe(401);
      // активные записи перешли администратору (в том числе у бывшего руководителя), закрытые остались у прежнего владельца
      expect((await p().lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId).toBe(nozima.id);
      expect((await p().lead.findUniqueOrThrow({ where: { id: headLead.id } })).ownerId).toBe(nozima.id);
      expect((await p().lead.findUniqueOrThrow({ where: { id: closedLead.id } })).ownerId).toBe(oldMgr.id);
      expect(await p().crmTask.count({ where: { responsibleUserId: { in: [oldMgr.id, oldHead.id] }, state: { in: ['pending', 'open'] } } })).toBe(0);
      // аудит не уменьшился (дописан), копия «до» сохранена
      expect(await p().auditLog.count()).toBeGreaterThanOrEqual(auditBefore);
      const saved = await p().$queryRawUnsafe<Array<{ kind: string; entity_id: string }>>(`SELECT kind, entity_id FROM _backup_cutover_20261026 WHERE kind = 'lead_owner' AND entity_id = '${lead.id}'`);
      expect(saved).toHaveLength(1);
      // новые лиды получает рабочий менеджер из основной очереди (а не дежурный администратор)
      const realMgr = await p().user.findUniqueOrThrow({ where: { login: ACCOUNTS.find((a) => a.role === 'MANAGER')!.login } });
      const fresh = await newLead(app, core);
      expect(fresh.ownerId).toBe(realMgr.id);
      expect(fresh.assignmentReason).toBe('round_robin');
      // дежурный администратор — только запасной вариант, когда в очереди никого нет
      await p().managerPoolMember.updateMany({ where: { userId: realMgr.id }, data: { available: false } });
      const fallback = await newLead(app, core);
      expect(fallback.ownerId).toBe(nozima.id);
      expect(fallback.assignmentReason).toBe('duty_fallback');
      // новый администратор входит по логину; повторное закрытие безопасно и ничего не меняет
      expect((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: ACCOUNTS[0]!.login, password: ACCOUNTS[0]!.password })).status).toBe(200);
      expect((await core.accounts.closeLegacy()).closed).toEqual([]);
    }), 240_000);
});
