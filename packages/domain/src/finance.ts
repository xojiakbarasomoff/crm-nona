/**
 * Tannarx, sotuv va foyda (TZ qo‘shimchasi §A). Sof funksiyalar: bazaga bog‘liq emas.
 *
 * Qoidalar:
 *  - DASTLABKI foyda = sotuv narxi (selling) − tannarx (net).
 *  - QAYTARIMDAN KEYINGI foyda = (selling − mijozga qaytarilgan summa) − (net − yetkazib beruvchidan qaytgan summa).
 *  - Qo‘shimcha xarajatlar (komissiya, soliq, bank to‘lovi, valyuta farqi) hisobga olinmaydi: bu ko‘rsatkichlar
 *    buxgalteriya «sof foydasi» emas.
 *  - Pul — bigint minor birliklar; valyutalar hech qachon kurssiz qo‘shilmaydi (har bir hisob valyuta bo‘yicha).
 *  - Tannarx kiritilmagan bo‘lsa, u 0 deb hisoblanmaydi: foyda «aniqlanmagan».
 *  - Paket narxi va uning ichiga kiritilgan xizmatlar ikki marta sanalmaydi.
 */

export interface FinanceLine {
  /** 'package' — buyurtma darajasidagi (turpaket) narx; 'service' — alohida xizmat qatori. */
  kind: 'package' | 'service';
  id: string;
  sellingMinor: bigint | null;
  netMinor: bigint | null;
  currency: string | null;
  /** Xizmat paket narxiga kiritilgan: ma’lumot uchun ko‘rsatiladi, yig‘indiga qo‘shilmaydi. */
  includedInPackage?: boolean;
  /** Olib tashlangan qator (soft-delete): tarixda qoladi, hisobga kirmaydi. */
  removed?: boolean;
}

/** Valyuta bo‘yicha qaytarimlar: mijozga qaytarilgan va yetkazib beruvchidan qaytgan (alohida qayd etiladi). */
export interface CurrencyRefunds {
  customerMinor: bigint;
  supplierMinor: bigint;
}
export type RefundsByCurrency = Record<string, CurrencyRefunds>;

export type ProfitState = 'known' | 'undetermined';

export interface CurrencyFinance {
  currency: string;
  /** Sanalgan qatorlar sotuv narxlari yig‘indisi (faqat ma’lum qiymatlar). */
  sellingMinor: bigint;
  /** Sanalgan qatorlarning ma’lum tannarxlari yig‘indisi (to‘liq bo‘lmasligi mumkin — profitState ga qarang). */
  netMinor: bigint;
  /** Dastlabki foyda; tannarx yoki sotuv narxi to‘liq bo‘lmasa null. Manfiy bo‘lishi mumkin. */
  profitMinor: bigint | null;
  profitState: ProfitState;
  lines: number;
  missingNetLines: number;
  missingSellingLines: number;
  /** Mijozga qaytarilgan summa (shu valyutada). */
  customerRefundedMinor: bigint;
  /** Yetkazib beruvchidan qaytgan summa (shu valyutada). */
  supplierRefundedMinor: bigint;
  /** Qaytarimdan keyingi sotuv: selling − mijozga qaytarilgan. */
  sellingAfterRefundMinor: bigint;
  /** Qaytarimdan keyingi tannarx: net − yetkazib beruvchidan qaytgan (tannarx to‘liq ma’lum bo‘lmasa null). */
  netAfterRefundMinor: bigint | null;
  /** Qaytarimdan keyingi foyda; dastlabki foyda aniqlanmagan bo‘lsa null. */
  profitAfterRefundMinor: bigint | null;
}

export interface OrderFinance {
  byCurrency: Record<string, CurrencyFinance>;
  /** Hech bo‘lmaganda bitta narxli qator bor. */
  hasPrice: boolean;
  /** Narxi bor, lekin kamida bitta valyutada foyda aniqlanmagan. */
  profitUndetermined: boolean;
  /** Narxli qatori yo‘q valyutada qayd etilgan qaytarimlar (kurs yo‘q — hisobga olinmaydi, ogohlantiriladi). */
  refundCurrencyMismatch: string[];
}

/** Hisobga kiradigan qatorlar: olib tashlanmagan, paketga kiritilmagan, valyutasi va kamida bitta narxi bor. */
export function countedLines(lines: FinanceLine[]): FinanceLine[] {
  return lines.filter((l) => !l.removed && !(l.kind === 'service' && l.includedInPackage) && !!l.currency && (l.sellingMinor !== null || l.netMinor !== null));
}

export function computeOrderFinance(lines: FinanceLine[], refunds: RefundsByCurrency = {}): OrderFinance {
  const byCurrency: Record<string, CurrencyFinance> = {};
  for (const l of countedLines(lines)) {
    const c = (byCurrency[l.currency!] ??= {
      currency: l.currency!,
      sellingMinor: 0n,
      netMinor: 0n,
      profitMinor: null,
      profitState: 'undetermined',
      lines: 0,
      missingNetLines: 0,
      missingSellingLines: 0,
      customerRefundedMinor: 0n,
      supplierRefundedMinor: 0n,
      sellingAfterRefundMinor: 0n,
      netAfterRefundMinor: null,
      profitAfterRefundMinor: null,
    });
    c.lines++;
    if (l.sellingMinor !== null) c.sellingMinor += l.sellingMinor;
    else c.missingSellingLines++;
    if (l.netMinor !== null) c.netMinor += l.netMinor;
    else c.missingNetLines++;
  }
  for (const c of Object.values(byCurrency)) {
    const r = refunds[c.currency] ?? { customerMinor: 0n, supplierMinor: 0n };
    c.customerRefundedMinor = r.customerMinor;
    c.supplierRefundedMinor = r.supplierMinor;
    c.sellingAfterRefundMinor = c.sellingMinor - r.customerMinor;
    if (c.missingNetLines === 0 && c.missingSellingLines === 0) {
      c.profitMinor = c.sellingMinor - c.netMinor;
      c.profitState = 'known';
      c.netAfterRefundMinor = c.netMinor - r.supplierMinor;
      c.profitAfterRefundMinor = c.sellingAfterRefundMinor - c.netAfterRefundMinor;
    }
  }
  const all = Object.values(byCurrency);
  const mismatch = Object.entries(refunds)
    .filter(([ccy, r]) => !byCurrency[ccy] && (r.customerMinor !== 0n || r.supplierMinor !== 0n))
    .map(([ccy]) => ccy)
    .sort();
  return { byCurrency, hasPrice: all.length > 0, profitUndetermined: all.some((c) => c.profitState === 'undetermined'), refundCurrencyMismatch: mismatch };
}

/** Buyurtmaning yagona valyutadagi jami sotuv narxi; bir nechta valyuta yoki narx yo‘q bo‘lsa null. */
export function singleCurrencySelling(f: OrderFinance): { amountMinor: bigint; currency: string } | null {
  const cs = Object.values(f.byCurrency).filter((c) => c.lines > 0);
  if (cs.length !== 1 || cs[0]!.missingSellingLines > 0) return null;
  return { amountMinor: cs[0]!.sellingMinor, currency: cs[0]!.currency };
}

/** Qaytarimni yozishdan oldin tekshiruv: valyuta buyurtmaning narxli qatorlariga mos kelishi shart (kurs yo‘q). */
export type RefundCheck = { ok: true } | { ok: false; code: 'REFUND_CURRENCY_MISMATCH' | 'REFUND_EXCEEDS_RECEIVED' | 'SUPPLIER_REFUND_EXCEEDS_NET' | 'NET_UNKNOWN'; message: string };

export function checkCustomerRefund(f: OrderFinance, p: { currency: string; amountMinor: bigint; receivedMinor: bigint; refundedMinor: bigint }): RefundCheck {
  if (!f.byCurrency[p.currency]) return { ok: false, code: 'REFUND_CURRENCY_MISMATCH', message: `Qaytarim valyutasi (${p.currency}) buyurtma narxlari valyutasiga mos emas (kurs bo‘yicha avtomatik o‘zgartirilmaydi)` };
  if (p.refundedMinor + p.amountMinor > p.receivedMinor) return { ok: false, code: 'REFUND_EXCEEDS_RECEIVED', message: 'Qaytarim qabul qilingan to‘lovlardan oshib ketmasligi kerak' };
  return { ok: true };
}

export function checkSupplierRefund(f: OrderFinance, p: { currency: string; amountMinor: bigint; refundedMinor: bigint }): RefundCheck {
  const c = f.byCurrency[p.currency];
  if (!c) return { ok: false, code: 'REFUND_CURRENCY_MISMATCH', message: `Qaytarim valyutasi (${p.currency}) buyurtma narxlari valyutasiga mos emas (kurs bo‘yicha avtomatik o‘zgartirilmaydi)` };
  if (c.lines - c.missingNetLines === 0) return { ok: false, code: 'NET_UNKNOWN', message: 'Avval tannarxni kiriting: yetkazib beruvchi qaytarimi tannarxga nisbatan hisoblanadi' };
  if (p.refundedMinor + p.amountMinor > c.netMinor) return { ok: false, code: 'SUPPLIER_REFUND_EXCEEDS_NET', message: 'Yetkazib beruvchidan qaytgan summa tannarxdan oshib ketmasligi kerak' };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------
// Dashboard yig‘indisi
// ------------------------------------------------------------------------------------------

/**
 * confirmed — davrda birinchi marta WON bo‘lgan lidning bekor qilinmagan buyurtmasi (qaytarimlari bo‘lsa ham:
 *   qaytarim dastlabki foydani o‘zgartirmaydi, «qaytarimdan keyingi foyda»da alohida ko‘rsatiladi);
 * open — hali WON/LOST bo‘lmagan lidning bekor qilinmagan buyurtmasi («Kutilayotgan foyda» manbai);
 * cancelled — buyurtma bekor qilingan (summalar tarixda saqlanadi, jami sotuvga kirmaydi).
 */
export type FinanceBucket = 'confirmed' | 'open' | 'cancelled';

export interface FinanceOrderInput {
  orderId: string;
  bucket: FinanceBucket;
  finance: OrderFinance;
  /** Menejer (tarixiy mas’ul) kaliti; null — taqsimlanmagan. */
  managerId: string | null;
  /** Buyurtmaning turoperatori (tarixiy bog‘lanish); null — ko‘rsatilmagan. */
  operatorId: string | null;
}

export interface MoneyAgg {
  sales: bigint;
  /** Mijozga qaytarilgan va yetkazib beruvchidan qaytgan (barcha tasdiqlangan buyurtmalar bo‘yicha). */
  customerRefunded: bigint;
  supplierRefunded: bigint;
  /** Foyda hisoblangan (aniq) buyurtmalar: sotuv, tannarx, dastlabki foyda. */
  basisSales: bigint;
  basisNet: bigint;
  profit: bigint;
  /** Shu buyurtmalar bo‘yicha qaytarimdan keyingi sotuv, tannarx va foyda. */
  basisSalesAfterRefund: bigint;
  basisNetAfterRefund: bigint;
  profitAfterRefund: bigint;
  basisOrders: number;
  undeterminedOrders: number;
  undeterminedSales: bigint;
  /** Kamida bitta qaytarimi bor buyurtmalar soni. */
  ordersWithRefund: number;
}

const emptyAgg = (): MoneyAgg => ({
  sales: 0n,
  customerRefunded: 0n,
  supplierRefunded: 0n,
  basisSales: 0n,
  basisNet: 0n,
  profit: 0n,
  basisSalesAfterRefund: 0n,
  basisNetAfterRefund: 0n,
  profitAfterRefund: 0n,
  basisOrders: 0,
  undeterminedOrders: 0,
  undeterminedSales: 0n,
  ordersWithRefund: 0,
});

function addOrder(agg: MoneyAgg, c: CurrencyFinance) {
  agg.sales += c.sellingMinor;
  agg.customerRefunded += c.customerRefundedMinor;
  agg.supplierRefunded += c.supplierRefundedMinor;
  if (c.customerRefundedMinor !== 0n || c.supplierRefundedMinor !== 0n) agg.ordersWithRefund++;
  if (c.profitState === 'known') {
    agg.basisSales += c.sellingMinor;
    agg.basisNet += c.netMinor;
    agg.profit += c.profitMinor!;
    agg.basisSalesAfterRefund += c.sellingAfterRefundMinor;
    agg.basisNetAfterRefund += c.netAfterRefundMinor!;
    agg.profitAfterRefund += c.profitAfterRefundMinor!;
    agg.basisOrders++;
  } else {
    agg.undeterminedOrders++;
    agg.undeterminedSales += c.sellingMinor;
  }
}

export interface FinanceSummary {
  /** Tasdiqlangan sotuvlar, valyuta bo‘yicha. */
  confirmed: Record<string, MoneyAgg>;
  /** Kutilayotgan foyda (ochiq buyurtmalar), valyuta bo‘yicha. */
  expected: Record<string, { profit: bigint; orders: number; undeterminedOrders: number }>;
  cancelled: Record<string, { sales: bigint; orders: number }>;
  /** Tasdiqlangan buyurtmalar: kamida bitta valyutada foyda aniqlanmagan (tannarx yo‘q/qisman). */
  undeterminedOrders: number;
  /** Tasdiqlangan buyurtmalar: narx umuman kiritilmagan. */
  unpricedOrders: number;
  /** Tasdiqlangan buyurtmalar: qaytarim valyutasi narx valyutasiga mos emas (hisobga olinmagan). */
  refundMismatchOrders: number;
  byOperator: Array<{ operatorId: string | null; orders: number; undeterminedOrders: number; currencies: Record<string, MoneyAgg> }>;
  byManager: Array<{ managerId: string | null; orders: number; undeterminedOrders: number; currencies: Record<string, MoneyAgg> }>;
}

export function summarizeFinance(orders: FinanceOrderInput[], opts: { currency?: string } = {}): FinanceSummary {
  const keep = (c: string) => !opts.currency || c === opts.currency;
  const out: FinanceSummary = { confirmed: {}, expected: {}, cancelled: {}, undeterminedOrders: 0, unpricedOrders: 0, refundMismatchOrders: 0, byOperator: [], byManager: [] };
  const op = new Map<string | null, FinanceSummary['byOperator'][number]>();
  const mg = new Map<string | null, FinanceSummary['byManager'][number]>();

  for (const o of orders) {
    const cs = Object.values(o.finance.byCurrency).filter((c) => keep(c.currency));
    if (o.bucket === 'confirmed') {
      if (opts.currency && cs.length === 0) continue; // boshqa valyutadagi buyurtma filtrdan tashqarida
      if (!o.finance.hasPrice) out.unpricedOrders++;
      if (o.finance.refundCurrencyMismatch.length) out.refundMismatchOrders++;
      const undetermined = cs.some((c) => c.profitState === 'undetermined');
      if (undetermined) out.undeterminedOrders++;
      const opRow = op.get(o.operatorId) ?? { operatorId: o.operatorId, orders: 0, undeterminedOrders: 0, currencies: {} };
      const mgRow = mg.get(o.managerId) ?? { managerId: o.managerId, orders: 0, undeterminedOrders: 0, currencies: {} };
      opRow.orders++;
      mgRow.orders++;
      if (undetermined) {
        opRow.undeterminedOrders++;
        mgRow.undeterminedOrders++;
      }
      for (const c of cs) {
        addOrder((out.confirmed[c.currency] ??= emptyAgg()), c);
        addOrder((opRow.currencies[c.currency] ??= emptyAgg()), c);
        addOrder((mgRow.currencies[c.currency] ??= emptyAgg()), c);
      }
      op.set(o.operatorId, opRow);
      mg.set(o.managerId, mgRow);
    } else if (o.bucket === 'open') {
      for (const c of cs) {
        const e = (out.expected[c.currency] ??= { profit: 0n, orders: 0, undeterminedOrders: 0 });
        if (c.profitState === 'known') {
          e.profit += c.profitMinor!;
          e.orders++;
        } else e.undeterminedOrders++;
      }
    } else {
      for (const c of cs) {
        const t = (out.cancelled[c.currency] ??= { sales: 0n, orders: 0 });
        t.sales += c.sellingMinor;
        t.orders++;
      }
    }
  }
  out.byOperator = [...op.values()];
  out.byManager = [...mg.values()];
  return out;
}

/** Foizli marja (profit / selling), faqat sotuv > 0 va foyda aniq bo‘lsa. Butun son foiz ×100 (2 xona). */
export function marginPercent(sellingMinor: bigint, profitMinor: bigint): string | null {
  if (sellingMinor <= 0n) return null;
  const scaled = (profitMinor * 10000n) / sellingMinor; // 2 xonali kasr (×100)
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
