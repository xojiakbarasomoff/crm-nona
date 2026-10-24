import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/**
 * Request DTOs for the backend API (TZ §18). Inputs are allowlisted: unknown keys are rejected.
 * These are our API shapes, not amoCRM or Meta endpoints.
 */

const id = z.string().uuid();
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'decimal string, e.g. "1250.00"');
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'local wall-clock time, e.g. 2026-10-25T10:30');
const isoDateTime = z.string().datetime({ offset: true });

export const STAGE = z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'PREPARING_OFFER', 'OFFER_SENT', 'AWAITING_PAYMENT', 'WON', 'LOST', 'FOLLOW_UP']);
export const CHANNEL = z.enum(['instagram_lead_ads', 'meta_lead_ads', 'instagram_direct', 'amocrm', 'manual', 'other']);
export const SERVICE_TYPE = z.enum(['avia', 'tour_package', 'hotel', 'visa', 'other']);

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), field_errors: z.record(z.string()).optional(), details: z.record(z.unknown()).optional() }),
    request_id: z.string(),
  })
  .openapi('Error');

export const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() }).strict().openapi('LoginRequest');
export const ActivateSchema = z.object({ token: z.string().min(20), password: z.string().min(12).max(200) }).strict();
export const MfaConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const InviteUserSchema = z.object({ email: z.string().email(), fullName: z.string().min(1).max(200), role: z.enum(['ADMIN', 'HEAD', 'MANAGER']), amoUserId: z.string().max(40).nullable() }).strict();
export const ChangeRoleSchema = z.object({ role: z.enum(['ADMIN', 'HEAD', 'MANAGER']) }).strict();
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
  })
  .strict()
  .openapi('LeadDetailsPatch');

export const StageChangeSchema = z.object({ version: z.number().int(), stage: STAGE, reason: z.string().max(1000).optional() }).strict().openapi('StageChange');
export const AssigneeSchema = z.object({ userId: id, reason: z.string().min(1).max(1000) }).strict();
export const ReopenSchema = z.object({ reason: z.string().min(1).max(1000), stage: STAGE.default('CONTACTED') }).strict();

export const OfferSchema = z
  .object({
    content: z.string().min(1).max(20000),
    amount: decimal,
    currency,
    validUntil: isoDateTime.nullable().default(null),
    options: z.array(z.record(z.unknown())).max(20).optional(),
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
    agreedAmount: decimal.optional(),
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
export const PassengerSchema = z.object({ fullName: z.string().min(1).max(200), type: z.enum(['adult', 'child', 'infant']), birthDate: date.nullable().optional() }).strict();
export const ServiceSchema = z.object({ serviceType: SERVICE_TYPE, description: z.string().min(1).max(2000), amount: decimal.nullable().optional(), currency: currency.nullable().optional() }).strict();
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
    bucket: z.enum(['day', 'week', 'month']).default('day'),
  })
  .strict();

export const DuplicateResolveSchema = z.object({ action: z.enum(['dismiss', 'mark_shared', 'merge', 'flag']), primaryContactId: id.optional(), note: z.string().max(1000).optional() }).strict();
export const AmoOAuthStartSchema = z.object({ domain: z.string().min(3).max(100) }).strict();
export const AmoOAuthCallbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1), referer: z.string().min(3) }).passthrough();

export const DemoLeadAdsSchema = z.object({ fullName: z.string().min(1).max(100), phone: z.string().max(30).optional(), email: z.string().email().optional(), destination: z.string().max(100).optional(), platform: z.enum(['ig', 'fb']).nullable().optional(), adId: z.string().max(40).nullable().optional() }).strict();
export const DemoDirectSchema = z.object({ scopedSenderId: z.string().min(3).max(40), text: z.string().min(1).max(1000), referralAdId: z.string().max(40).nullable().optional() }).strict();
export const DemoAmoChatReplySchema = z.object({ conversationId: id, text: z.string().min(1).max(1000), authorAmoUserId: z.string().max(40) }).strict();
