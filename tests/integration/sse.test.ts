import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { publishEvent } from '../../apps/api/src/core';
import { alwaysOnDuty, companyId, login, makeApp, makeCore, newLead, type Session } from './helpers';

let core: Core;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  core = makeCore();
  await alwaysOnDuty(core);
  app = await makeApp(core);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await core.close();
});

/** Opens the SSE stream and collects `change` events for `ms` milliseconds. */
async function collect(s: Session, ms: number, during: () => Promise<void>): Promise<Array<{ entityId: string; kind: string }>> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/v1/events`, { headers: { cookie: s.cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const events: Array<{ entityId: string; kind: string }> = [];
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('event: change')) events.push(JSON.parse(chunk.split('\ndata: ')[1]!));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await new Promise((r) => setTimeout(r, 300)); // subscription established
  await during();
  await new Promise((r) => setTimeout(r, ms));
  controller.abort();
  await pump;
  return events;
}

describe('SSE respects object-level access (AC12)', () => {
  it('only the owner (and heads) receive a lead change; access follows owner changes', async () => {
    const lead = await newLead(app, core);
    const owner = await core.deps.prisma.user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    const other = await core.deps.prisma.user.findFirstOrThrow({ where: { role: 'MANAGER', id: { not: owner.id }, email: { endsWith: '@demo.local' } } });
    const sOwner = await login(app, owner.email);
    const sOther = await login(app, other.email);
    const sHead = await login(app, 'admin2@demo.local');
    const fire = () => publishEvent(core.deps.redis, { companyId, entityType: 'lead', entityId: lead.id, ownerId: owner.id, kind: 'updated' });

    const [ownerEvents, otherEvents, headEvents] = await Promise.all([collect(sOwner, 700, fire), collect(sOther, 700, async () => undefined), collect(sHead, 700, async () => undefined)]);
    expect(ownerEvents.some((e) => e.entityId === lead.id)).toBe(true);
    expect(headEvents.some((e) => e.entityId === lead.id)).toBe(true);
    expect(otherEvents.some((e) => e.entityId === lead.id)).toBe(false);

    // Reassign in the projection: the next event goes to the new owner only (fresh DB check per event).
    await core.deps.prisma.lead.update({ where: { id: lead.id }, data: { ownerId: other.id } });
    const [ownerAfter, otherAfter] = await Promise.all([collect(sOwner, 700, fire), collect(sOther, 700, async () => undefined)]);
    expect(ownerAfter.some((e) => e.entityId === lead.id)).toBe(false);
    expect(otherAfter.some((e) => e.entityId === lead.id)).toBe(true);
  });

  it('events of another company are never forwarded', async () => {
    const sHead = await login(app, 'admin2@demo.local');
    const events = await collect(sHead, 500, () => publishEvent(core.deps.redis, { companyId: '00000000-0000-4000-8000-0000000000ff', entityType: 'lead', entityId: '00000000-0000-4000-8000-0000000000aa', kind: 'updated' }));
    expect(events).toEqual([]);
  });

  it('unauthenticated stream is rejected', async () => {
    const r = await fetch(`${base}/api/v1/events`);
    expect(r.status).toBe(401);
  });
});
