/** Денежные и подписи-помощники (интерфейс). Расчёты выполняет сервер; здесь только отображение. */

export const CURRENCY_LABEL: Record<string, string> = { UZS: 'сум', USD: '$', EUR: '€' };
export const CURRENCIES = ['USD', 'UZS', 'EUR'] as const;

/** "58500000.00" → "58 500 000" (kasr faqat nolga teng bo‘lmasa ko‘rsatiladi). */
export const fmtAmount = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
};

export const fmtMoney = (v: string | null | undefined, currency: string | null | undefined) => (v === null || v === undefined ? '—' : `${fmtAmount(v)} ${CURRENCY_LABEL[currency ?? ''] ?? currency ?? ''}`.trim());

export const money = (m: Record<string, string>) => (Object.keys(m).length ? Object.entries(m).map(([c, v]) => `${fmtAmount(v)} ${CURRENCY_LABEL[c] ?? c}`).join(' · ') : '—');

/** Ikki o'nli kasrli decimal satrlarni bigint (minor birlik) sifatida ayiradi — floating point ishlatilmaydi. */
export function profitPreview(selling: string, net: string): string | null {
  const parse = (s: string) => {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
    return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0') : null;
  };
  const a = parse(selling);
  const b = parse(net);
  if (a === null || b === null) return null;
  const d = a - b;
  const neg = d < 0n;
  const abs = neg ? -d : d;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export const SERVICE_TYPE_LABELS: Record<string, string> = {
  avia: 'Авиабилеты',
  tour_package: 'Турпакет',
  hotel: 'Отель',
  transfer: 'Трансфер',
  visa: 'Виза',
  other: 'Другое',
};

export const SUPPLIER_KIND_LABELS: Record<string, string> = {
  tour_operator: 'Туроператор',
  hotel: 'Отель',
  transfer: 'Трансфер',
  airline: 'Авиаагент / авиакомпания',
  other: 'Другое',
};

export const DOC_CATEGORY_LABELS: Record<string, string> = {
  passport: 'Паспорт',
  invoice: 'Счёт (инвойс)',
  payment_receipt: 'Чек об оплате',
  air_ticket: 'Авиабилет',
  voucher: 'Ваучер на отель / тур',
  other: 'Прочие документы',
};

export const MEAL_PLANS = ['RO', 'BB', 'HB', 'FB', 'AI', 'UAI'] as const;

export const FULFILLMENT_LABELS: Record<string, string> = {
  draft: 'Черновик',
  confirmed: 'Подтверждён',
  in_progress: 'В работе',
  completed: 'Завершён',
  cancelled: 'Отменён',
};

export const PAYMENT_LABELS: Record<string, string> = {
  unpaid: 'Не оплачен',
  partial: 'Оплачен частично',
  paid: 'Оплачен',
  refund_pending: 'Возврат ожидается',
  refunded: 'Возвращён',
};

export const TICKETING_LABELS: Record<string, string> = {
  not_required: 'Не требуется',
  pending: 'Ожидает оформления',
  reserved: 'Забронирован',
  issued: 'Выписан',
  voided: 'Аннулирован',
};

export const MESSAGE_STATE_LABELS: Record<string, string> = {
  received: 'Получено',
  queued: 'В очереди',
  sending: 'Отправляется',
  accepted: 'Принято Instagram',
  delivered: 'Доставлено',
  read: 'Прочитано',
  failed: 'Не отправлено',
  unknown: 'Результат неизвестен',
};

export const OCCURRENCE_STATE_LABELS: Record<string, string> = {
  scheduled: 'Запланировано',
  dispatching: 'Отправляется',
  due: 'Пора выполнить',
  completed: 'Выполнено',
  snoozed: 'Отложено',
  cancelled: 'Отменено',
  superseded: 'Заменено',
  missed: 'Пропущено',
};

export const USER_STATUS_LABELS: Record<string, string> = {
  invited: 'Приглашён',
  active: 'Активен',
  blocked: 'Заблокирован',
};

export const ACTOR_LABELS: Record<string, string> = { customer: 'Клиент', human: 'Сотрудник', bot: 'Бот', system: 'Система' };

export const IDENTIFIER_LABELS: Record<string, string> = { instagram_scoped: 'Instagram (ID)', phone: 'Телефон', email: 'Email' };

export const PLACEMENT_LABELS: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', unknown: 'место неизвестно', instagram_form_mapping: 'форма Instagram' };
