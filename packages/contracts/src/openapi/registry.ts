import { OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z, type ZodTypeAny } from 'zod';
import * as S from '../schemas';

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  idempotent?: boolean;
  auth?: 'session' | 'webhook' | 'none';
}

/** Single source for the backend API surface (TZ §18.1). These are not provider endpoints. */
export const ROUTES: Route[] = [
  { method: 'post', path: '/api/v1/auth/login', tag: 'auth', summary: 'Sessiya ochish', body: S.LoginSchema, auth: 'none' },
  { method: 'post', path: '/api/v1/auth/logout', tag: 'auth', summary: 'Sessiyani tugatish' },
  { method: 'post', path: '/api/v1/auth/activate', tag: 'auth', summary: 'Taklif havolasi orqali parol o‘rnatish', body: S.ActivateSchema, auth: 'none' },
  { method: 'post', path: '/api/v1/auth/mfa/enroll', tag: 'auth', summary: 'Administrator MFA sozlashni boshlash' },
  { method: 'post', path: '/api/v1/auth/mfa/confirm', tag: 'auth', summary: 'MFA kodini tasdiqlash', body: S.MfaConfirmSchema },
  { method: 'get', path: '/api/v1/me', tag: 'auth', summary: 'Foydalanuvchi va huquqlar' },
  { method: 'get', path: '/api/v1/users', tag: 'users', summary: 'Foydalanuvchilar (admin)' },
  { method: 'post', path: '/api/v1/users', tag: 'users', summary: 'Xodimni taklif qilish (admin)', body: S.InviteUserSchema },
  { method: 'patch', path: '/api/v1/users/{id}/role', tag: 'users', summary: 'Rolni o‘zgartirish', body: S.ChangeRoleSchema },
  { method: 'post', path: '/api/v1/users/{id}/block', tag: 'users', summary: 'Bloklash va ishlarni o‘tkazish', body: S.BlockUserSchema },
  { method: 'get', path: '/api/v1/dashboard', tag: 'dashboard', summary: 'Filtrlangan ko‘rsatkichlar', query: S.DashboardQuery },
  { method: 'get', path: '/api/v1/exports/leads.csv', tag: 'dashboard', summary: 'Huquqli CSV eksport', query: S.DashboardQuery },
  { method: 'get', path: '/api/v1/leads', tag: 'leads', summary: 'Ro‘yxat, qidiruv va voronka', query: S.LeadListQuery },
  { method: 'get', path: '/api/v1/leads/{id}', tag: 'leads', summary: 'Lid va tarix' },
  { method: 'patch', path: '/api/v1/leads/{id}', tag: 'leads', summary: 'Turizm talablari va lokal maydonlar', body: S.LeadDetailsSchema },
  { method: 'patch', path: '/api/v1/leads/{id}/stage', tag: 'leads', summary: 'Statusni biznes qoidalari bilan yangilash (amoCRM orqali, 202)', body: S.StageChangeSchema },
  { method: 'patch', path: '/api/v1/leads/{id}/assignee', tag: 'leads', summary: 'Rahbar tomonidan qayta tayinlash (202)', body: S.AssigneeSchema },
  { method: 'post', path: '/api/v1/leads/{id}/reopen', tag: 'leads', summary: 'Yopilgan lidni sabab bilan qayta ochish', body: S.ReopenSchema },
  { method: 'post', path: '/api/v1/leads/{id}/offers', tag: 'offers', summary: 'Taklif yoki yangi versiya', body: S.OfferSchema, idempotent: true },
  { method: 'post', path: '/api/v1/offers/{id}/sent', tag: 'offers', summary: 'Taklif yuborildi deb belgilash', body: S.OfferSentSchema },
  { method: 'post', path: '/api/v1/offers/{id}/accept', tag: 'offers', summary: 'Mijoz taklifni tasdiqladi' },
  { method: 'get', path: '/api/v1/contacts/{id}', tag: 'contacts', summary: 'Profil, murojaatlar va buyurtmalar' },
  { method: 'get', path: '/api/v1/duplicates', tag: 'contacts', summary: 'Dublikat nomzodlari' },
  { method: 'post', path: '/api/v1/duplicates/{id}/resolve', tag: 'contacts', summary: 'Bog‘lash yoki merge qarorini boshlash', body: S.DuplicateResolveSchema },
  { method: 'get', path: '/api/v1/orders', tag: 'orders', summary: 'Buyurtmalar', query: S.PaginationQuery },
  { method: 'post', path: '/api/v1/orders', tag: 'orders', summary: 'Buyurtma yaratish', body: S.OrderCreateSchema, idempotent: true },
  { method: 'get', path: '/api/v1/orders/{id}', tag: 'orders', summary: 'To‘liq buyurtma' },
  { method: 'patch', path: '/api/v1/orders/{id}', tag: 'orders', summary: 'Buyurtma tahriri', body: S.OrderPatchSchema },
  { method: 'post', path: '/api/v1/orders/{id}/payments', tag: 'orders', summary: 'To‘lovni qo‘lda qayd etish (Idempotency-Key majburiy)', body: S.PaymentSchema, idempotent: true },
  { method: 'post', path: '/api/v1/orders/{id}/passengers', tag: 'orders', summary: 'Yo‘lovchi', body: S.PassengerSchema },
  { method: 'post', path: '/api/v1/orders/{id}/services', tag: 'orders', summary: 'Xizmat', body: S.ServiceSchema },
  { method: 'post', path: '/api/v1/orders/{id}/tickets', tag: 'orders', summary: 'Chipta (yo‘lovchi + segmentlar)', body: S.TicketSchema },
  { method: 'post', path: '/api/v1/orders/{id}/segments', tag: 'flights', summary: 'Reys segmenti qo‘shish', body: S.SegmentSchema },
  { method: 'patch', path: '/api/v1/segments/{id}', tag: 'flights', summary: 'Jadval va ma’lumotlarni o‘zgartirish', body: S.SegmentPatchSchema },
  { method: 'post', path: '/api/v1/segments/{id}/checks', tag: 'flights', summary: 'Tekshiruvni boshlash yoki natijani saqlash', body: S.CheckSchema },
  { method: 'post', path: '/api/v1/segments/{id}/customer-notifications', tag: 'flights', summary: 'Mijoz xabardor qilindi', body: S.CustomerNotificationSchema },
  { method: 'get', path: '/api/v1/flights', tag: 'flights', summary: 'Saralangan segmentlar dashboard’i', query: S.FlightsQuery },
  { method: 'get', path: '/api/v1/reminders', tag: 'reminders', summary: 'Eslatmalar', query: S.ReminderListQuery },
  { method: 'post', path: '/api/v1/reminders', tag: 'reminders', summary: 'Qo‘lda eslatma', body: S.ReminderCreateSchema },
  { method: 'patch', path: '/api/v1/reminders/{id}', tag: 'reminders', summary: 'Snooze yoki bekor qilish', body: S.ReminderPatchSchema },
  { method: 'post', path: '/api/v1/reminders/{id}/complete', tag: 'reminders', summary: 'Natija bilan bajarish (faqat qo‘lda eslatma)', body: S.ReminderCompleteSchema },
  { method: 'patch', path: '/api/v1/reminder-rules/{milestone}', tag: 'reminders', summary: 'Milestone qoidasini versiyalab o‘zgartirish (admin)', body: S.RuleUpdateSchema },
  { method: 'get', path: '/api/v1/notifications', tag: 'reminders', summary: 'Ilova bildirishnomalari' },
  { method: 'get', path: '/api/v1/integrations/health', tag: 'integrations', summary: 'Ulanish va navbat diagnostikasi' },
  { method: 'post', path: '/api/v1/integrations/replay/{id}', tag: 'integrations', summary: 'Ruxsatli operator tomonidan xavfsiz replay' },
  { method: 'post', path: '/api/v1/integrations/amocrm/oauth/start', tag: 'integrations', summary: 'amoCRM OAuth boshlash', body: S.AmoOAuthStartSchema },
  { method: 'get', path: '/api/v1/integrations/amocrm/oauth/callback', tag: 'integrations', summary: 'amoCRM OAuth callback', query: S.AmoOAuthCallbackQuery },
  { method: 'post', path: '/api/v1/integrations/{id}/disconnect', tag: 'integrations', summary: 'Ulanishni uzish' },
  { method: 'post', path: '/api/v1/attachments', tag: 'files', summary: 'Fayl yuklash (raw body; ownerType, ownerId query; X-File-Name)' },
  { method: 'get', path: '/api/v1/attachments', tag: 'files', summary: 'Obyekt fayllari (skan holati bilan)' },
  { method: 'post', path: '/api/v1/attachments/{id}/link', tag: 'files', summary: 'Qisqa muddatli, foydalanuvchiga bog‘langan yuklab olish havolasi (faqat skan qilingan)' },
  { method: 'get', path: '/api/v1/attachments/{id}/content', tag: 'files', summary: 'Imzolangan yuklab olish (sessiya + imzo + RBAC)' },
  { method: 'delete', path: '/api/v1/attachments/{id}', tag: 'files', summary: 'Faylni o‘chirish' },
  { method: 'post', path: '/api/v1/contacts/{id}/erase', tag: 'privacy', summary: 'Shaxsiy ma’lumotlarni o‘chirish/anonimlashtirish (admin)' },
  { method: 'get', path: '/api/v1/privacy/retention', tag: 'privacy', summary: 'Retention siyosati holati' },
  { method: 'post', path: '/api/v1/privacy/retention/confirm', tag: 'privacy', summary: 'Retention muddatlarini tasdiqlash (admin)' },
  { method: 'post', path: '/api/v1/privacy/retention/run', tag: 'privacy', summary: 'Retention tozalashni ishga tushirish' },
  { method: 'post', path: '/api/v1/integrations/amocrm/import', tag: 'integrations', summary: 'amoCRM boshlang‘ich importi (worker, 202)' },
  { method: 'post', path: '/api/v1/integrations/lead-ads/backfill', tag: 'integrations', summary: 'Lead Ads tarixini qayta olish (worker, 202)' },
  { method: 'get', path: '/api/v1/events', tag: 'realtime', summary: 'Huquqlarga mos SSE oqimi' },
  { method: 'get', path: '/webhooks/meta', tag: 'webhooks', summary: 'Meta verify challenge', auth: 'webhook' },
  { method: 'post', path: '/webhooks/meta', tag: 'webhooks', summary: 'Meta hodisalari (X-Hub-Signature-256)', auth: 'webhook' },
  { method: 'post', path: '/webhooks/amocrm/crm/{opaque_connection}', tag: 'webhooks', summary: 'amoCRM CRM webhook (form-urlencoded)', auth: 'webhook' },
  { method: 'post', path: '/webhooks/amocrm/chat/{scope}', tag: 'webhooks', summary: 'amoCRM Chats webhook (X-Signature)', auth: 'webhook' },
  { method: 'get', path: '/health', tag: 'ops', summary: 'Process liveness', auth: 'none' },
  { method: 'get', path: '/ready', tag: 'ops', summary: 'Readiness: DB, Redis', auth: 'none' },
];

export function buildOpenApi() {
  const registry = new OpenAPIRegistry();
  registry.register('Error', S.ErrorSchema);
  registry.registerComponent('securitySchemes', 'session', { type: 'apiKey', in: 'cookie', name: 'crm_session' });
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    registry.registerPath({
      method: r.method,
      path: r.path,
      tags: [r.tag],
      summary: r.summary,
      security: r.auth === 'none' || r.auth === 'webhook' ? [] : [{ session: [] }],
      request: {
        ...(params.length ? { params: z.object(Object.fromEntries(params.map((p) => [p, z.string()]))) } : {}),
        ...(r.query ? { query: r.query as never } : {}),
        ...(r.body ? { body: { content: { 'application/json': { schema: r.body } } } } : {}),
        ...(r.idempotent || (r.method !== 'get' && r.auth !== 'webhook' && r.auth !== 'none')
          ? { headers: z.object({ 'X-CSRF-Token': z.string(), ...(r.idempotent ? { 'Idempotency-Key': z.string() } : {}) }) }
          : {}),
      },
      responses: {
        200: { description: 'OK' },
        ...(r.auth === 'none' ? {} : { 401: { description: 'Unauthorized', content: { 'application/json': { schema: S.ErrorSchema } } } }),
        403: { description: 'Forbidden', content: { 'application/json': { schema: S.ErrorSchema } } },
        404: { description: 'Not found (also for objects outside your scope)', content: { 'application/json': { schema: S.ErrorSchema } } },
        409: { description: 'Conflict / version / idempotency', content: { 'application/json': { schema: S.ErrorSchema } } },
        422: { description: 'Validation / business rule', content: { 'application/json': { schema: S.ErrorSchema } } },
        429: { description: 'Rate limited', content: { 'application/json': { schema: S.ErrorSchema } } },
      },
    });
  }
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'Turizm CRM backend API', version: '0.1.0', description: 'Backend API of this project (TZ §18). Not amoCRM/Meta endpoints. All times ISO 8601 with offset; money as decimal strings with ISO currency.' },
    servers: [{ url: '/' }],
  });
}
