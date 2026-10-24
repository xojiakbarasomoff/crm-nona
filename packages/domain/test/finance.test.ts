import { describe, expect, it } from 'vitest';
import { computeOrderFinance, countedLines, marginPercent, parseMoney, singleCurrencySelling, summarizeFinance, type FinanceLine, type FinanceOrderInput } from '../src';

const m = (v: string, c = 'UZS') => parseMoney(v, c).amountMinor;
const pkg = (selling: string | null, net: string | null, currency: string | null = 'UZS'): FinanceLine => ({
  kind: 'package',
  id: 'pkg',
  sellingMinor: selling === null ? null : m(selling, currency!),
  netMinor: net === null ? null : m(net, currency!),
  currency,
});
const svc = (id: string, selling: string | null, net: string | null, o: Partial<FinanceLine> = {}): FinanceLine => ({
  kind: 'service',
  id,
  sellingMinor: selling === null ? null : m(selling, (o.currency as string) ?? 'UZS'),
  netMinor: net === null ? null : m(net, (o.currency as string) ?? 'UZS'),
  currency: 'UZS',
  ...o,
});

describe('foyda = sotuv narxi − tannarx', () => {
  it('1 200 sotuv va 1 000 tannarxdan 200 foyda', () => {
    const f = computeOrderFinance([pkg('1200', '1000')]);
    expect(f.byCurrency.UZS).toMatchObject({ sellingMinor: m('1200'), netMinor: m('1000'), profitMinor: m('200'), profitState: 'known' });
    expect(f.profitUndetermined).toBe(false);
  });

  it('manfiy foyda to‘g‘ri hisoblanadi', () => {
    const f = computeOrderFinance([pkg('900', '1000')]);
    expect(f.byCurrency.UZS!.profitMinor).toBe(m('-100'));
    expect(f.byCurrency.UZS!.profitState).toBe('known');
  });

  it('nol foyda — aniq nol, «aniqlanmagan» emas', () => {
    const f = computeOrderFinance([pkg('1000', '1000')]);
    expect(f.byCurrency.UZS!.profitMinor).toBe(0n);
    expect(f.byCurrency.UZS!.profitState).toBe('known');
  });

  it('tannarxi noma’lum buyurtma: 0 deb hisoblanmaydi, foyda aniqlanmagan', () => {
    const f = computeOrderFinance([pkg('1200', null)]);
    expect(f.byCurrency.UZS!.profitMinor).toBeNull();
    expect(f.byCurrency.UZS!.profitState).toBe('undetermined');
    expect(f.byCurrency.UZS!.missingNetLines).toBe(1);
    expect(f.profitUndetermined).toBe(true);
  });

  it('tannarx 0 aniq kiritilgan bo‘lsa (masalan, bepul xizmat) — foyda sotuvga teng', () => {
    const f = computeOrderFinance([pkg('500', '0')]);
    expect(f.byCurrency.UZS!.profitMinor).toBe(m('500'));
  });
});

describe('paket va xizmatlar ikki marta sanalmaydi', () => {
  it('paketga kiritilgan xizmatlar yig‘indiga qo‘shilmaydi', () => {
    const f = computeOrderFinance([pkg('1000', '800'), svc('h', '600', '500', { includedInPackage: true }), svc('t', '100', '60', { includedInPackage: true })]);
    expect(f.byCurrency.UZS).toMatchObject({ sellingMinor: m('1000'), netMinor: m('800'), profitMinor: m('200'), lines: 1 });
  });

  it('paketdan tashqari xizmat paket ustiga qo‘shiladi', () => {
    const f = computeOrderFinance([pkg('1000', '800'), svc('h', '600', '500', { includedInPackage: true }), svc('visa', '100', '60')]);
    expect(f.byCurrency.UZS).toMatchObject({ sellingMinor: m('1100'), netMinor: m('860'), profitMinor: m('240') });
  });

  it('paket yo‘q bo‘lsa, jami qiymat xizmatlar yig‘indisi', () => {
    const f = computeOrderFinance([svc('a', '300', '200'), svc('b', '700', '650')]);
    expect(f.byCurrency.UZS).toMatchObject({ sellingMinor: m('1000'), netMinor: m('850'), profitMinor: m('150') });
  });

  it('olib tashlangan qator hisobga kirmaydi, lekin ro‘yxatda qoladi', () => {
    const lines = [svc('a', '300', '200'), svc('x', '999', '1', { removed: true })];
    expect(computeOrderFinance(lines).byCurrency.UZS!.sellingMinor).toBe(m('300'));
    expect(countedLines(lines)).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });

  it('bitta qatorda tannarx yo‘q bo‘lsa, butun valyuta bo‘yicha foyda aniqlanmagan', () => {
    const f = computeOrderFinance([svc('a', '300', '200'), svc('b', '700', null)]);
    expect(f.byCurrency.UZS!.profitState).toBe('undetermined');
    expect(f.byCurrency.UZS!.sellingMinor).toBe(m('1000'));
    expect(f.byCurrency.UZS!.netMinor).toBe(m('200')); // faqat ma’lum qismi
  });
});

describe('valyutalar kurssiz qo‘shilmaydi', () => {
  it('USD va UZS alohida hisoblanadi', () => {
    const f = computeOrderFinance([pkg('1200', '1000', 'USD'), svc('t', '500000', '300000', { currency: 'UZS' })]);
    expect(f.byCurrency.USD!.profitMinor).toBe(m('200', 'USD'));
    expect(f.byCurrency.UZS!.profitMinor).toBe(m('200000'));
    expect(Object.keys(f.byCurrency).sort()).toEqual(['USD', 'UZS']);
    expect(singleCurrencySelling(f)).toBeNull(); // bir nechta valyuta: yagona jami yo‘q
  });

  it('yagona valyutada yagona jami qaytadi', () => {
    expect(singleCurrencySelling(computeOrderFinance([pkg('1200', '1000')]))).toEqual({ amountMinor: m('1200'), currency: 'UZS' });
  });
});

const order = (id: string, bucket: FinanceOrderInput['bucket'], lines: FinanceLine[], o: Partial<FinanceOrderInput> = {}): FinanceOrderInput => ({
  orderId: id,
  bucket,
  finance: computeOrderFinance(lines),
  managerId: 'mA',
  operatorId: 'opX',
  ...o,
});

describe('dashboard yig‘indisi', () => {
  it('tasdiqlangan sotuvlar: sotuv, tannarx, foyda va aniqlanmaganlar soni', () => {
    const s = summarizeFinance([
      order('1', 'confirmed', [pkg('1200', '1000')]),
      order('2', 'confirmed', [pkg('900', '1000')], { managerId: 'mB', operatorId: 'opY' }),
      order('3', 'confirmed', [pkg('500', null)]), // eski buyurtma, tannarx yo‘q
    ]);
    expect(s.confirmed.UZS).toMatchObject({ sales: m('2600'), basisSales: m('2100'), basisNet: m('2000'), profit: m('100'), basisOrders: 2, undeterminedOrders: 1, undeterminedSales: m('500') });
    expect(s.undeterminedOrders).toBe(1);
    const x = s.byOperator.find((r) => r.operatorId === 'opX')!;
    expect(x.currencies.UZS).toMatchObject({ sales: m('1700'), profit: m('200'), undeterminedOrders: 1 });
    const mb = s.byManager.find((r) => r.managerId === 'mB')!;
    expect(mb.currencies.UZS!.profit).toBe(m('-100'));
  });

  it('bekor qilingan va to‘liq qaytarilgan buyurtmalar jami sotuvga kirmaydi, tarixda alohida ko‘rinadi', () => {
    const s = summarizeFinance([
      order('1', 'confirmed', [pkg('1200', '1000')]),
      order('2', 'cancelled', [pkg('800', '700')]),
      order('3', 'refunded', [pkg('600', '500')]),
    ]);
    expect(s.confirmed.UZS!.sales).toBe(m('1200'));
    expect(s.cancelled.UZS).toEqual({ sales: m('800'), orders: 1 });
    expect(s.refunded.UZS).toEqual({ sales: m('600'), orders: 1 });
  });

  it('kutilayotgan foyda faqat ochiq buyurtmalardan, alohida', () => {
    const s = summarizeFinance([order('1', 'confirmed', [pkg('1200', '1000')]), order('2', 'open', [pkg('400', '300')]), order('3', 'open', [pkg('400', null)])]);
    expect(s.confirmed.UZS!.profit).toBe(m('200'));
    expect(s.expected.UZS).toEqual({ profit: m('100'), orders: 1, undeterminedOrders: 1 });
  });

  it('valyuta filtri: boshqa valyuta aralashmaydi', () => {
    const s = summarizeFinance([order('1', 'confirmed', [pkg('1200', '1000', 'USD')]), order('2', 'confirmed', [pkg('500000', '400000', 'UZS')])], { currency: 'USD' });
    expect(Object.keys(s.confirmed)).toEqual(['USD']);
    expect(s.byManager[0]!.orders).toBe(1);
  });

  it('narxi umuman yo‘q tasdiqlangan buyurtma alohida sanaladi', () => {
    const s = summarizeFinance([order('1', 'confirmed', [])]);
    expect(s.unpricedOrders).toBe(1);
  });
});

describe('marja', () => {
  it('foizni butun sonlarda hisoblaydi', () => {
    expect(marginPercent(m('1200'), m('200'))).toBe('16.66');
    expect(marginPercent(m('1000'), m('-100'))).toBe('-10.00');
    expect(marginPercent(0n, 0n)).toBeNull();
  });
});
