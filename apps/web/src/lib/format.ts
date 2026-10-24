/** Pul va yorliq yordamchilari (interfeys). Hisob-kitob serverda bajariladi; bu yerda faqat ko'rsatish. */

export const CURRENCY_LABEL: Record<string, string> = { UZS: 'so‘m', USD: '$', EUR: '€' };
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
  avia: 'Avia',
  tour_package: 'Turpaket',
  hotel: 'Mehmonxona',
  transfer: 'Transfer',
  visa: 'Viza',
  other: 'Boshqa',
};

export const SUPPLIER_KIND_LABELS: Record<string, string> = {
  tour_operator: 'Turoperator',
  hotel: 'Mehmonxona',
  transfer: 'Transfer',
  airline: 'Avia agent / aviakompaniya',
  other: 'Boshqa',
};

export const DOC_CATEGORY_LABELS: Record<string, string> = {
  passport: 'Pasport',
  invoice: 'Hisob-faktura (invoice)',
  payment_receipt: 'To‘lov cheki',
  air_ticket: 'Aviachipta',
  voucher: 'Mehmonxona / tur vaucheri',
  other: 'Boshqa hujjatlar',
};

export const MEAL_PLANS = ['RO', 'BB', 'HB', 'FB', 'AI', 'UAI'] as const;
