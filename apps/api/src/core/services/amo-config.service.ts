import { STAGES, type Stage } from '@crm/domain';
import type { AmoPipeline } from '@crm/integrations';
import type { CoreDeps } from '../context';

/**
 * `amo-config` (TZ §17): checks the amoCRM pipeline and custom fields. Dry-run reports what is
 * missing; apply creates only missing parts and stores IDs in integration_mappings. Re-running is
 * idempotent and nothing existing is deleted or renamed.
 */

export const REQUIRED_FIELDS: Array<{ entity: 'leads' | 'contacts'; code: string; name: string; type: string; localId: string }> = [
  { entity: 'leads', code: 'EXTERNAL_OPERATION_ID', name: 'external_operation_id', type: 'text', localId: 'external_operation_id' },
  { entity: 'leads', code: 'FIRST_SOURCE', name: 'Birinchi manba', type: 'text', localId: 'first_source' },
  { entity: 'leads', code: 'SOURCE_CREATED_AT', name: 'Murojaat vaqti', type: 'text', localId: 'source_created_at' },
  { entity: 'leads', code: 'FORM_ID', name: 'Lead forma ID', type: 'text', localId: 'form_id' },
  { entity: 'leads', code: 'CAMPAIGN_REF', name: 'Kampaniya', type: 'text', localId: 'campaign_ref' },
  { entity: 'leads', code: 'AD_REF', name: 'Reklama', type: 'text', localId: 'ad_ref' },
  { entity: 'leads', code: 'TRAVEL_LEAD_URL', name: 'Turizm lid havolasi', type: 'url', localId: 'travel_lead_url' },
  { entity: 'leads', code: 'TRAVEL_ORDER_ID', name: 'Buyurtma raqami', type: 'text', localId: 'travel_order_id' },
  { entity: 'leads', code: 'TRAVEL_ORDER_URL', name: 'Buyurtma havolasi', type: 'url', localId: 'travel_order_url' },
  { entity: 'leads', code: 'LOCAL_AMOUNT', name: 'Kelishilgan summa (valyuta bilan)', type: 'text', localId: 'local_amount' },
  { entity: 'leads', code: 'NEXT_DEPARTURE_AT', name: 'Keyingi jo‘nash', type: 'text', localId: 'next_departure_at' },
  { entity: 'leads', code: 'NEXT_FLIGHT_NO', name: 'Keyingi reys', type: 'text', localId: 'next_flight_no' },
  { entity: 'leads', code: 'NEXT_CHECK_STATE', name: 'Tekshiruv holati', type: 'text', localId: 'next_check_state' },
  { entity: 'leads', code: 'NEXT_REMINDER_AT', name: 'Keyingi eslatma', type: 'text', localId: 'next_reminder_at' },
  { entity: 'contacts', code: 'INSTAGRAM_USERNAME', name: 'Instagram username', type: 'text', localId: 'instagram_username' },
  { entity: 'contacts', code: 'INSTAGRAM_SCOPED_REF', name: 'Instagram scoped ID', type: 'text', localId: 'instagram_scoped_ref' },
];

/** Default status names looked up in the chosen pipeline (configurable via the stage map). */
export const DEFAULT_STAGE_NAMES: Record<Exclude<Stage, 'WON' | 'LOST'>, string> = {
  NEW: 'Yangi lid',
  CONTACTED: 'Mijoz bilan aloqa o‘rnatildi',
  QUALIFIED: 'Mijoz talablari aniqlandi',
  PREPARING_OFFER: 'Taklif tayyorlanmoqda',
  OFFER_SENT: 'Taklif mijozga yuborildi',
  AWAITING_PAYMENT: 'To‘lov kutilmoqda',
  FOLLOW_UP: 'Qayta aloqa talab qilinadi',
};

export interface AmoConfigPlan {
  pipeline: { id: string; name: string } | null;
  statuses: Array<{ stage: Stage; status: 'mapped' | 'found' | 'create'; statusId: string | null; name: string }>;
  fields: Array<{ entity: string; code: string; status: 'mapped' | 'found' | 'create'; fieldId: string | null }>;
  applied: boolean;
}

export async function runAmoConfig(d: CoreDeps, opts: { companyId: string; pipelineId?: string; apply: boolean; stageNames?: Partial<Record<Stage, string>> }): Promise<AmoConfigPlan> {
  const conn = await d.prisma.integrationConnection.findFirstOrThrow({ where: { companyId: opts.companyId, provider: 'AMOCRM_REST', disconnectedAt: null } });
  const client = d.adapters.amoRest(conn);
  const pipelines = await client.listPipelines();
  const pipeline: AmoPipeline | undefined = opts.pipelineId ? pipelines.find((p) => p.id === opts.pipelineId) : (pipelines.find((p) => p.isMain) ?? pipelines[0]);
  const plan: AmoConfigPlan = { pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null, statuses: [], fields: [], applied: opts.apply };
  if (!pipeline) return plan;

  const names = { ...DEFAULT_STAGE_NAMES, ...(opts.stageNames ?? {}) } as Record<string, string>;
  for (const stage of STAGES) {
    const existingMap = await d.prisma.integrationMapping.findFirst({ where: { companyId: opts.companyId, entityType: 'pipeline_status', localId: stage, externalId: { startsWith: `${pipeline.id}:` } } });
    if (existingMap) {
      plan.statuses.push({ stage, status: 'mapped', statusId: existingMap.externalId.split(':')[1]!, name: names[stage] ?? stage });
      continue;
    }
    const found =
      stage === 'WON' ? pipeline.statuses.find((s) => s.type === 'won') : stage === 'LOST' ? pipeline.statuses.find((s) => s.type === 'lost') : pipeline.statuses.find((s) => s.name.trim().toLowerCase() === (names[stage] ?? '').trim().toLowerCase());
    let statusId = found?.id ?? null;
    if (!statusId && opts.apply && stage !== 'WON' && stage !== 'LOST') statusId = (await client.createPipelineStatus(pipeline.id, names[stage]!)).id;
    plan.statuses.push({ stage, status: found ? 'found' : 'create', statusId, name: names[stage] ?? stage });
    if (opts.apply && statusId) {
      await d.prisma.integrationMapping.upsert({
        where: { companyId_entityType_externalId: { companyId: opts.companyId, entityType: 'pipeline_status', externalId: `${pipeline.id}:${statusId}` } },
        create: { companyId: opts.companyId, connectionId: conn.id, entityType: 'pipeline_status', localId: stage, externalId: `${pipeline.id}:${statusId}` },
        update: {},
      });
    }
  }

  const existing = { leads: await client.listCustomFields('leads'), contacts: await client.listCustomFields('contacts') };
  for (const f of REQUIRED_FIELDS) {
    const mapped = await d.prisma.integrationMapping.findFirst({ where: { companyId: opts.companyId, entityType: 'custom_field', localId: f.localId } });
    if (mapped) {
      plan.fields.push({ entity: f.entity, code: f.code, status: 'mapped', fieldId: mapped.externalId });
      continue;
    }
    const found = existing[f.entity].find((x) => x.code === f.code);
    let fieldId = found?.id ?? null;
    if (!fieldId && opts.apply) fieldId = (await client.createCustomField(f.entity, { name: f.name, type: f.type, code: f.code })).id;
    plan.fields.push({ entity: f.entity, code: f.code, status: found ? 'found' : 'create', fieldId });
    if (opts.apply && fieldId) {
      await d.prisma.integrationMapping.upsert({
        where: { companyId_entityType_externalId: { companyId: opts.companyId, entityType: "custom_field", externalId: fieldId } },
        create: { companyId: opts.companyId, connectionId: conn.id, entityType: 'custom_field', localId: f.localId, externalId: fieldId, meta: { entity: f.entity, code: f.code } },
        update: {},
      });
    }
  }
  return plan;
}
