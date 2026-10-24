/**
 * Live smoke tests for G01–G09 (TZ §3.1). This script never reports success without a real
 * provider response. Results are written (redacted) to docs/feasibility-runs/<timestamp>.json.
 *
 *   npm run smoke:live -- [--only=G01,G02] [--allow-writes]
 *
 * --allow-writes permits creating clearly marked test records in the amoCRM test account (G01).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, loadConfig } from '@crm/api/core';
import { redactBody } from '@crm/integrations';

type Result = { id: string; status: 'passed' | 'failed' | 'blocked'; detail: string; at: string };

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');
const allowWrites = process.argv.includes('--allow-writes');

async function main() {
  const config = loadConfig();
  const results: Result[] = [];
  const push = (id: string, status: Result['status'], detail: string) => {
    if (only && !only.includes(id)) return;
    results.push({ id, status, detail: redactBody(detail), at: new Date().toISOString() });
  };

  if (config.mode === 'demo') {
    for (const id of ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09']) push(id, 'blocked', 'APP_MODE=demo: demo adapters cannot prove live integration');
    return finish(results);
  }

  const core = createCore(config);
  try {
    const amo = await core.deps.prisma.integrationConnection.findFirst({ where: { provider: 'AMOCRM_REST', mode: 'live', disconnectedAt: null } });
    if (!amo) {
      push('G01', 'blocked', 'No live AMOCRM_REST connection. Connect via /integrations (OAuth) first.');
      push('G02', 'blocked', 'No live AMOCRM_REST connection.');
    } else {
      const client = core.deps.adapters.amoRest(amo);
      try {
        const account = await client.getAccount();
        const users = await client.listUsers();
        const pipelines = await client.listPipelines();
        let detail = `account=${account.id} subdomain=${account.subdomain} users=${users.length} pipelines=${pipelines.length}`;
        if (allowWrites) {
          const status = pipelines[0]?.statuses.find((s) => s.type === 'normal');
          if (!status) throw new Error('No normal status in first pipeline');
          const marker = `SMOKE-${Date.now()}`;
          const created = await client.createLeadWithContact({ name: `[TEST] ${marker}`, pipelineId: pipelines[0]!.id, statusId: status.id, responsibleUserId: null, operationId: marker, operationFieldId: null, customFields: [], contact: { existingId: null, name: `[TEST] ${marker}`, phone: null, email: null } });
          const task = await client.createTask({ entityType: 'leads', entityId: created.leadId, text: `[TEST] ${marker}`, completeTill: new Date(Date.now() + 3600_000), responsibleUserId: null, operationKey: marker });
          const back = await client.getLead(created.leadId);
          detail += ` created lead=${created.leadId} task=${task.taskId} readBack=${back?.id === created.leadId}`;
          push('G01', back?.id === created.leadId ? 'passed' : 'failed', detail);
        } else {
          push('G01', 'blocked', `${detail}; write test skipped (pass --allow-writes on a TEST account)`);
        }
      } catch (err) {
        push('G01', 'failed', (err as Error).message);
      }
      try {
        const token = await core.oauth.refreshWithLock(amo.id, null);
        const again = await client.getAccount();
        push('G02', token && again.id ? 'passed' : 'failed', `refresh ok, API call after refresh ok (account ${again.id}); disconnect check: see integration test AC34`);
      } catch (err) {
        push('G02', 'failed', (err as Error).message);
      }
    }
    const meta = await core.deps.prisma.integrationConnection.findMany({ where: { provider: { in: ['META_LEADS', 'META_DIRECT'] }, mode: 'live' } });
    push('G03', meta.length ? 'blocked' : 'blocked', meta.length ? 'Live Meta connections exist; asset listing must be recorded manually with Business Manager screenshots' : 'No live Meta connection (requires Meta app, Page, IG professional account)');
    for (const id of ['G04', 'G05', 'G06', 'G09']) push(id, 'blocked', 'Requires a real test event from Meta (form submission / DM) — run manually and capture the inbox row; see docs/feasibility.md');
    push('G07', 'blocked', `Configured login=${config.meta.directLogin} graphVersion=${config.meta.graphVersion || 'unset'}; App Review / access level must be confirmed in Meta App Dashboard`);
    const chats = await core.deps.prisma.integrationConnection.findFirst({ where: { provider: 'AMOCRM_CHATS', mode: 'live' } });
    push('G08', 'blocked', chats ? 'Chats connection exists; send a test message through amoCRM and capture the webhook' : 'No registered amoCRM Chats channel (AMO_CHAT_CHANNEL_ID / secret)');
  } finally {
    await core.close();
  }
  finish(results);
}

function finish(results: Result[]) {
  const dir = join(__dirname, '..', '..', '..', '..', 'docs', 'feasibility-runs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.table(results.map((r) => ({ id: r.id, status: r.status, detail: r.detail.slice(0, 120) })));
  console.log(`Saved to ${file}`);
}

main().catch((err) => {
  console.error('smoke-live failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
