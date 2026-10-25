/**
 * Synthetic load dataset (TZ §22.1): 20 users, 50k contacts, 100k leads, 1M messages, 10k segments.
 * Uses set-based SQL (generate_series) for speed. Demo-only and refuses to run on a database that
 * is not explicitly named as a perf database.
 *
 *   PERF_DATABASE_URL=postgresql://.../crm_perf npm run perf:seed -- --scale=1
 */
import { randomBytes } from 'node:crypto';
import { createPrisma, loadEncryptionKey } from './index';
import { DEMO_COMPANY_ID, seed } from './seed';

async function main() {
  const url = process.env.PERF_DATABASE_URL;
  if (!url || !/crm_perf/.test(url)) throw new Error('Set PERF_DATABASE_URL to a database whose name contains "crm_perf"');
  const scale = Number(process.argv.find((a) => a.startsWith('--scale='))?.split('=')[1] ?? '1');
  const n = (x: number) => Math.max(1, Math.round(x * scale));
  const prisma = createPrisma(url);
  const t0 = Date.now();
  try {
    await seed(prisma, { demoData: true, key: loadEncryptionKey() });
    const c = DEMO_COMPANY_ID;
    const users = await prisma.user.findMany({ where: { companyId: c }, select: { id: true } });
    for (let i = users.length; i < 20; i++) {
      await prisma.user.create({ data: { companyId: c, email: `perf${i}@demo.local`, fullName: `Perf Menejer ${i}`, role: 'MANAGER', status: 'active' } });
    }
    const managerIds = (await prisma.user.findMany({ where: { companyId: c, role: 'MANAGER' }, select: { id: true } })).map((u) => u.id);
    const direct = await prisma.integrationConnection.findFirstOrThrow({ where: { companyId: c, provider: 'META_DIRECT' } });
    const run = (sql: string) => prisma.$executeRawUnsafe(sql);
    const owners = `(ARRAY['${managerIds.join("','")}']::uuid[])`;
    const tag = randomBytes(3).toString('hex');

    await run(`INSERT INTO contacts (id, company_id, full_name, primary_phone, owner_id, sync_state, created_at, updated_at)
      SELECT gen_random_uuid(), '${c}', 'Perf Mijoz ' || g, '+99890' || lpad(g::text, 7, '0'), ${owners}[1 + g % ${managerIds.length}], 'synced', now() - (g % 365) * interval '1 day', now()
      FROM generate_series(1, ${n(50_000)}) g`);
    await run(`INSERT INTO leads (id, company_id, contact_id, name, stage, owner_id, first_source, sync_state, requirements, created_at, updated_at, closed_at, first_won_at, amo_lead_id)
      SELECT gen_random_uuid(), c.company_id, c.id, 'Perf lid ' || row_number() over (), (ARRAY['NEW','CONTACTED','QUALIFIED','OFFER_SENT','WON','LOST','FOLLOW_UP'])[1 + (random()*6)::int]::"Stage",
             c.owner_id, (ARRAY['instagram_lead_ads','meta_lead_ads','instagram_direct'])[1 + (random()*2)::int]::"Channel", 'synced', '{}', c.created_at, now(), NULL, NULL, 'perf-${tag}-' || row_number() over ()
      FROM contacts c CROSS JOIN generate_series(1, 2) k WHERE c.company_id = '${c}' AND c.full_name LIKE 'Perf Mijoz %' LIMIT ${n(100_000)}`);
    await run(`UPDATE leads SET closed_at = created_at + interval '3 days', first_won_at = CASE WHEN stage = 'WON' THEN created_at + interval '3 days' END WHERE company_id = '${c}' AND stage IN ('WON','LOST') AND name LIKE 'Perf lid %'`);
    await run(`INSERT INTO conversations (id, company_id, connection_id, business_account_id, scoped_peer_id, contact_id, lead_id, first_inbound_at, last_inbound_at, created_at, updated_at)
      SELECT gen_random_uuid(), l.company_id, '${direct.id}', '${direct.accountId}', 'perf-${tag}-' || l.id, l.contact_id, l.id, l.created_at, l.created_at, now(), now()
      FROM leads l WHERE l.company_id = '${c}' AND l.first_source = 'instagram_direct' AND l.name LIKE 'Perf lid %'`);
    const convCount = await prisma.conversation.count({ where: { companyId: c, scopedPeerId: { startsWith: `perf-${tag}` } } });
    const perConv = Math.max(1, Math.ceil(n(1_000_000) / Math.max(1, convCount)));
    await run(`INSERT INTO messages (id, company_id, conversation_id, connection_id, provider_message_id, direction, type, content, state, actor_type, created_at, updated_at)
      SELECT gen_random_uuid(), cv.company_id, cv.id, cv.connection_id, 'perf-' || cv.id || '-' || k, CASE WHEN k % 2 = 0 THEN 'outbound' ELSE 'inbound' END::"MessageDirection", 'text', 'Perf xabar ' || k,
             CASE WHEN k % 2 = 0 THEN 'accepted' ELSE 'received' END::"MessageState", CASE WHEN k % 2 = 0 THEN 'human' ELSE 'customer' END::"ActorType", cv.created_at + k * interval '1 minute', now()
      FROM conversations cv CROSS JOIN generate_series(1, ${perConv}) k WHERE cv.scoped_peer_id LIKE 'perf-${tag}-%'`);
    await run(`INSERT INTO orders (id, company_id, order_no, lead_id, contact_id, owner_id, agreed_amount_minor, currency, fulfillment_state, created_at, updated_at)
      SELECT gen_random_uuid(), l.company_id, 'PF-${tag}-' || row_number() over (), l.id, l.contact_id, l.owner_id, (100000 + random()*900000)::bigint, (ARRAY['USD','UZS'])[1 + (random())::int], 'confirmed', now(), now()
      FROM leads l WHERE l.company_id = '${c}' AND l.stage = 'WON' AND l.name LIKE 'Perf lid %' LIMIT ${n(10_000)}`);
    await run(`INSERT INTO flight_segments (id, company_id, order_id, segment_no, origin_iata, destination_iata, marketing_carrier, flight_number, departure_at_utc, departure_timezone, arrival_timezone, owner_id, created_at, updated_at)
      SELECT gen_random_uuid(), o.company_id, o.id, 1, 'TAS', 'IST', 'TK', (300 + (random()*600)::int)::text, now() + (random()*30) * interval '1 day', 'Asia/Tashkent', 'Europe/Istanbul', o.owner_id, now(), now()
      FROM orders o WHERE o.order_no LIKE 'PF-${tag}-%'`);
    await run('ANALYZE');
    const counts = {
      users: await prisma.user.count(),
      contacts: await prisma.contact.count(),
      leads: await prisma.lead.count(),
      messages: await prisma.message.count(),
      segments: await prisma.flightSegment.count(),
    };
    console.log(JSON.stringify({ scale, counts, seconds: Math.round((Date.now() - t0) / 1000) }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
