import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);
// Сообщения проверки ввода (zod) — на русском языке.
z.config(z.locales.ru());

/**
 * Request DTOs for the backend API (TZ §18). Inputs are allowlisted: unknown keys are rejected.
 * These are our API shapes, not Meta endpoints.
 */

const id = z.string().uuid();
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'Введите число в формате «1250.00»');
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Введите местное время, например 2026-10-25T10:30');
const isoDateTime = z.string().datetime({ offset: true });

export const STAGE = z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'PREPARING_OFFER', 'OFFER_SENT', 'AWAITING_PAYMENT', 'WON', 'LOST', 'FOLLOW_UP']);
export const CHANNEL = z.enum(['instagram_lead_ads', 'meta_lead_ads', 'instagram_direct', 'amocrm', 'manual', 'other']);
export const LeadAdsConnectSchema = z.object({ pageId: z.string().regex(/^\d+$/), formIds: z.array(z.string().regex(/^\d+$/)).min(1).max(100) }).strict();
export const SERVICE_TYPE = z.enum(['avia', 'tour_package', 'hotel', 'transfer', 'visa', 'other']);
/** Hujjat kategoriyalari (TZ qo‘shimchasi §D). */
export const DOCUMENT_CATEGORY = z.enum(['passport', 'invoice', 'payment_receipt', 'air_ticket', 'voucher', 'other']);
export type DocumentCategory = z.infer<typeof DOCUMENT_CATEGORY>;
export const SUPPLIER_KIND = z.enum(['tour_operator', 'hotel', 'transfer', 'airline', 'other']);

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), field_errors: z.record(z.string(), z.string()).optional(), details: z.record(z.string(), z.unknown()).optional() }),
    request_id: z.string(),
  })
  .openapi('Error');

/** `email` — идентификатор входа: логин (например, nozima) или email. */
export const LoginSchema = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() }).strict().openapi('LoginRequest');
export const ActivateSchema = z.object({ token: z.string().min(20), password: z.string().min(12).max(200) }).strict();
export const MfaConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const InviteUserSchema = z.object({ email: z.string().email(), fullName: z.string().min(1).max(200), role: z.enum(['ADMIN', 'MANAGER', 'USER']) }).strict();
export const ChangeRoleSchema = z.object({ role: z.enum(['ADMIN', 'MANAGER', 'USER']) }).strict();
export const BlockUserSchema = z.object({ successorId: id.nullable() }).strict();

export const PaginationQuery = z.object({ cursor: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const LeadListQuery = PaginationQuery.extend({ stage: STAGE.optional(), ownerId: id.optional(), source: CHANNEL.optional(), search: z.string().max(100).optional() }).strict();

export const RequirementsSchema = z
  .object({
    serviceType: SERVICE_TYPE.nullable().optional(),
    origin: z.string().max(100).nullable().optional(),
    destination: z.string().max(100).nullable().optional(),
    dateFrom: date.nullable().optional(),
    dateTo: date.nullable().optional(),
    adults: z.number().int().min(0).max(99).nullable().optional(),
    children: z.number().int().min(0).max(99).nullable().optional(),
    infants: z.number().int().min(0).max(99).nullable().optional(),
    budgetState: z.enum(['known', 'undetermined']).nullable().optional(),
    budgetAmount: decimal.nullable().optional(),
    budgetCurrency: currency.nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    paymentDueAt: date.nullable().optional(),
  })
  .strict();

export const LeadDetailsSchema = z
  .object({
    version: z.number().int(),
    requirements: RequirementsSchema.optional(),
    serviceType: SERVICE_TYPE.nullable().optional(),
    contactOutcome: z.string().max(1000).nullable().optional(),
    offerPrepDueAt: isoDateTime.nullable().optional(),
    lostReasonCode: z.string().max(50).nullable().optional(),
    lostNote: z.string().max(2000).nullable().optional(),
    nextContactAt: isoDateTime.nullable().optional(),
    followUpNote: z.string().max(2000).nullable().optional(),
    /** Turoperator (yetkazib beruvchi). Reklama manbasi emas. null — tanlovni olib tashlash. */
    tourOperatorId: id.nullable().optional(),
  })
  .strict()
  .openapi('LeadDetailsPatch');

const optText = (max: number) => z.string().trim().max(max).nullable().optional();
export const ManualLeadCreateSchema = z
  .object({
    firstName: optText(100),
    lastName: optText(100),
    phone: optText(40),
    telegram: optText(120),
    name: optText(200),
    ownerId: id.nullable().optional(),
    note: optText(2000),
    existingContactId: id.nullable().optional(),
    forceNewContact: z.boolean().optional(),
  })
  .strict()
  .openapi('ManualLeadCreate');
export const ContactEditSchema = z
  .object({ firstName: optText(100), lastName: optText(100), phone: optText(40), telegram: optText(120), allowDuplicatePhone: z.boolean().optional() })
  .strict()
  .openapi('ContactEdit');

export const StageChangeSchema = z.object({ version: z.number().int(), stage: STAGE, reason: z.string().max(1000).optional() }).strict().openapi('StageChange');
export const AssigneeSchema = z.object({ userId: id, reason: z.string().min(1).max(1000) }).strict();
export const ReopenSchema = z.object({ reason: z.string().min(1).max(1000), stage: STAGE.default('CONTACTED') }).strict();

export const OfferSchema = z
  .object({
    content: z.string().min(1).max(20000),
    amount: decimal,
    currency,
    validUntil: isoDateTime.nullable().default(null),
    options: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    includedServices: z.array(z.string().max(200)).max(50).optional(),
    note: z.string().max(4000).nullable().optional(),
  })
  .strict()
  .openapi('OfferCreate');
export const OfferSentSchema = z.object({ channel: z.enum(['instagram_direct', 'phone', 'email', 'telegram', 'in_person', 'other']) }).strict();

export const OrderCreateSchema = z.object({ leadId: id, offerVersionId: id.nullable().optional(), agreedAmount: decimal.nullable().optional(), currency: currency.nullable().optional(), note: z.string().max(4000).nullable().optional() }).strict().openapi('OrderCreate');
export const OrderPatchSchema = z
  .object({
    version: z.number().int(),
    /** Paket darajasidagi sotuv narxi (selling price). */
    agreedAmount: decimal.optional(),
    /** Paket darajasidagi tannarx (net price); null — «noma’lum»ga qaytarish. Sotuv narxi bilan bir valyutada. */
    netPrice: decimal.nullable().optional(),
    /** Buyurtma turoperatori (tarixiy bog'lanish). Lid operatoridan alohida; tasdiqlangan buyurtmada sabab majburiy, audit bilan. */
    tourOperatorId: id.nullable().optional(),
    tourOperatorReason: z.string().max(500).nullable().optional(),
    currency: currency.optional(),
    saleEvidence: z.string().max(2000).nullable().optional(),
    note: z.string().max(4000).nullable().optional(),
    ticketingState: z.enum(['not_required', 'pending', 'reserved', 'issued', 'voided']).optional(),
    fulfillmentState: z.enum(['draft', 'confirmed', 'in_progress', 'completed', 'cancelled']).optional(),
    paymentState: z.enum(['unpaid', 'partial', 'paid', 'refund_pending', 'refunded']).optional(),
  })
  .strict()
  .openapi('OrderPatch');
export const PaymentSchema = z
  .object({ kind: z.enum(['payment', 'refund']), amount: decimal, currency, receivedAt: isoDateTime, method: z.enum(['cash', 'card', 'bank_transfer', 'online', 'other']), evidence: z.string().max(2000).nullable().optional(), reference: z.string().max(200).nullable().optional() })
  .strict()
  .openapi('PaymentCreate');
/** Yetkazib beruvchidan qaytgan summa (mijozga qaytarim — PaymentCreate kind=refund — alohida). Idempotency-Key majburiy. */
export const SupplierRefundSchema = z
  .object({ amount: decimal, currency, receivedAt: isoDateTime, supplierId: id.nullable().optional(), serviceId: id.nullable().optional(), reference: z.string().max(200).nullable().optional(), note: z.string().max(2000).nullable().optional() })
  .strict()
  .openapi('SupplierRefundCreate');
/** Menejerga tannarx va foydani ko'rish huquqini yoqish/o'chirish (administrator). */
export const FinanceAccessSchema = z.object({ enabled: z.boolean() }).strict().openapi('FinanceAccess');
export const PassengerSchema = z.object({ fullName: z.string().min(1).max(200), type: z.enum(['adult', 'child', 'infant']), birthDate: date.nullable().optional() }).strict();
const mealPlan = z.enum(['RO', 'BB', 'HB', 'FB', 'AI', 'UAI', 'other']);
export const HotelDetailsSchema = z
  .object({ hotelName: z.string().min(1).max(200), address: z.string().max(500).nullable().optional(), checkIn: date, checkOut: date, roomType: z.string().max(100).nullable().optional(), mealPlan: mealPlan.nullable().optional() })
  .strict()
  .refine((d) => d.checkOut > d.checkIn, { path: ['checkOut'], message: 'Дата выезда должна быть позже даты заезда' });
export const TransferDetailsSchema = z
  .object({ route: z.string().min(1).max(300), pickupAt: localDateTime, timezone: z.string().min(3).max(60).nullable().optional(), vehicle: z.string().max(100).nullable().optional() })
  .strict();

/** Xizmat turiga xos tafsilotlarni tekshiradi (mehmonxona, transfer). Boshqa turlarda tafsilot bo‘sh. */
export function validateServiceDetails(serviceType: string, details: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const schema = serviceType === 'hotel' ? HotelDetailsSchema : serviceType === 'transfer' ? TransferDetailsSchema : null;
  if (!schema) return { ok: true, value: {} };
  const r = schema.safeParse(details ?? {});
  if (r.success) return { ok: true, value: r.data as Record<string, unknown> };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) errors[`details.${issue.path.join('.') || '_'}`] = issue.message;
  return { ok: false, errors };
}

const ServiceFields = {
  serviceType: SERVICE_TYPE,
  description: z.string().min(1).max(2000),
  /** Sotuv narxi (mijozga). */
  amount: decimal.nullable().optional(),
  /** Tannarx (yetkazib beruvchidan). null/yo‘q = noma’lum (0 emas). */
  netAmount: decimal.nullable().optional(),
  currency: currency.nullable().optional(),
  supplierId: id.nullable().optional(),
  /** true: xizmat paket narxiga kiritilgan va jami hisobga qo‘shilmaydi (ikki marta sanalmasligi uchun). */
  includedInPackage: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};
export const ServiceSchema = z
  .object(ServiceFields)
  .strict()
  .superRefine((v, ctx) => {
    if ((v.amount || v.netAmount) && !v.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'При указании цены валюта обязательна' });
    const d = validateServiceDetails(v.serviceType, v.details);
    if (!d.ok) for (const [k, m] of Object.entries(d.errors)) ctx.addIssue({ code: 'custom', path: k.split('.'), message: m });
  })
  .openapi('ServiceCreate');
export const ServicePatchSchema = z.object(ServiceFields).partial().strict().openapi('ServicePatch');

export const SupplierCreateSchema = z
  .object({ name: z.string().trim().min(1).max(200), kind: SUPPLIER_KIND.default('tour_operator'), contactPerson: z.string().max(200).nullable().optional(), phone: z.string().max(40).nullable().optional(), email: z.string().email().max(200).nullable().optional(), note: z.string().max(2000).nullable().optional() })
  .strict()
  .openapi('SupplierCreate');
export const SupplierPatchSchema = z
  .object({ version: z.number().int(), name: z.string().trim().min(1).max(200).optional(), kind: SUPPLIER_KIND.optional(), contactPerson: z.string().max(200).nullable().optional(), phone: z.string().max(40).nullable().optional(), email: z.string().email().max(200).nullable().optional(), note: z.string().max(2000).nullable().optional(), status: z.enum(['active', 'archived']).optional() })
  .strict()
  .openapi('SupplierPatch');
export const SupplierListQuery = z.object({ status: z.enum(['active', 'archived', 'all']).default('active'), kind: SUPPLIER_KIND.optional(), q: z.string().max(100).optional() }).strict();
export const TicketSchema = z.object({ passengerId: id, ticketNumber: z.string().min(3).max(40), segmentIds: z.array(id).min(1).max(20) }).strict();

const LocalTime = z.object({ local: localDateTime, timezone: z.string().min(3).max(60), confirmedOffsetMinutes: z.number().int().min(-900).max(900).nullable().optional() }).strict();
const iata = z.string().regex(/^[A-Z]{3}$/);
export const SegmentSchema = z
  .object({
    direction: z.enum(['outbound', 'connection', 'return']),
    originIata: iata,
    destinationIata: iata,
    originAirportName: z.string().max(200).nullable().optional(),
    destinationAirportName: z.string().max(200).nullable().optional(),
    marketingCarrier: z.string().min(2).max(3),
    operatingCarrier: z.string().min(2).max(3).nullable().optional(),
    flightNumber: z.string().regex(/^\d{1,4}[A-Z]?$/),
    departure: LocalTime.nullable(),
    departureTimezone: z.string().min(3).max(60),
    arrival: LocalTime.nullable(),
    arrivalTimezone: z.string().min(3).max(60),
    pnr: z.string().max(20).nullable().optional(),
    bookingProvider: z.string().max(100).nullable().optional(),
    passengerIds: z.array(id).max(20).optional(),
  })
  .strict()
  .openapi('SegmentCreate');
export const SegmentPatchSchema = SegmentSchema.partial()
  .extend({ version: z.number().int(), operationalStatus: z.enum(['scheduled', 'schedule_changed', 'cancelled']).optional(), active: z.boolean().optional() })
  .strict()
  .openapi('SegmentPatch');
export const CheckSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z
    .object({
      action: z.literal('save'),
      result: z.enum(['confirmed', 'changed', 'cancelled']),
      observedDeparture: LocalTime.nullable().optional(),
      terminal: z.string().max(20).nullable().optional(),
      note: z.string().max(2000).nullable().optional(),
      customerNotificationNeeded: z.boolean(),
      occurrenceId: id.nullable().optional(),
    })
    .strict(),
]);
export const CustomerNotificationSchema = z.object({ channel: z.enum(['phone', 'instagram_direct', 'telegram', 'sms', 'email', 'in_person', 'other']), result: z.enum(['reached', 'not_reached', 'message_left']), note: z.string().max(2000).nullable().optional() }).strict();
export const FlightsQuery = PaginationQuery.extend({ filter: z.enum(['today', '24h', '7d', 'overdue', 'changed']).optional() }).strict();

const Recurrence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once') }).strict(),
  z.object({ kind: z.enum(['daily', 'weekly']), until: date.nullable().optional(), maxCount: z.number().int().min(1).max(366).nullable().optional() }).strict(),
]);
export const ReminderCreateSchema = z
  .object({ orderId: id, segmentId: id.nullable().optional(), title: z.string().min(1).max(200), body: z.string().max(2000).nullable().optional(), localStart: localDateTime, timezone: z.string().min(3).max(60), recurrence: Recurrence, assigneeId: id.nullable().optional() })
  .strict()
  .openapi('ReminderCreate');
export const ReminderPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snooze'), minutes: z.number().int().min(1).max(10080) }).strict(),
  z.object({ action: z.literal('cancel'), reason: z.string().min(1).max(500) }).strict(),
]);
export const ReminderCompleteSchema = z.object({ note: z.string().max(2000).nullable().optional() }).strict();
export const ReminderListQuery = PaginationQuery.extend({ state: z.enum(['scheduled', 'due', 'completed', 'snoozed', 'cancelled', 'missed', 'superseded']).optional() }).strict();
export const RuleUpdateSchema = z.object({ offsetSeconds: z.number().int().min(600).max(30 * 86400).optional(), enabled: z.boolean().optional(), escalateAfterMinutes: z.number().int().min(1).max(1440).optional() }).strict();

export const DashboardQuery = z
  .object({
    from: date,
    to: date,
    source: CHANNEL.optional(),
    ownerId: id.optional(),
    serviceType: SERVICE_TYPE.optional(),
    stage: STAGE.optional(),
    departureFrom: date.optional(),
    departureTo: date.optional(),
    /** Turoperator filtri (lidga biriktirilgan). */
    tourOperatorId: id.optional(),
    /** Valyuta filtri: faqat shu valyutadagi summalar hisoblanadi. */
    currency: currency.optional(),
    bucket: z.enum(['day', 'week', 'month']).default('day'),
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'Дата начала не может быть позже даты окончания', path: ['from'] });

export const SupplierImportSchema = z.object({ names: z.array(z.string().trim().min(1).max(200)).min(1).max(200) }).strict();


export const DemoLeadAdsSchema = z.object({ fullName: z.string().min(1).max(100), phone: z.string().max(30).optional(), email: z.string().email().optional(), destination: z.string().max(100).optional(), platform: z.enum(['ig', 'fb']).nullable().optional(), adId: z.string().max(40).nullable().optional() }).strict();
export const DemoDirectSchema = z.object({ scopedSenderId: z.string().min(3).max(40), text: z.string().min(1).max(1000), referralAdId: z.string().max(40).nullable().optional() }).strict();
