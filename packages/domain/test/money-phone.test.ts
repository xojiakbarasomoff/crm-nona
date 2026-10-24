import { describe, expect, it } from 'vitest';
import {
  addMoney,
  convertMoney,
  CurrencyMismatchError,
  formatMoney,
  InvalidMoneyError,
  normalizePhone,
  parseMoney,
  sumByCurrency,
} from '../src';

describe('money', () => {
  it('parses and formats decimal strings without floating point', () => {
    const m = parseMoney('0.10', 'USD');
    expect(m.amountMinor).toBe(10n);
    expect(formatMoney(addMoney(m, parseMoney('0.20', 'USD')))).toBe('0.30');
    expect(formatMoney(parseMoney('12345678901234567.89', 'UZS'))).toBe('12345678901234567.89');
  });

  it('rejects excess precision and garbage', () => {
    expect(() => parseMoney('1.234', 'USD')).toThrow(InvalidMoneyError);
    expect(() => parseMoney('1e3', 'USD')).toThrow(InvalidMoneyError);
    expect(() => parseMoney('10', 'XXX')).toThrow(InvalidMoneyError);
  });

  it('never adds UZS and USD (AC31)', () => {
    expect(() => addMoney(parseMoney('1', 'UZS'), parseMoney('1', 'USD'))).toThrow(CurrencyMismatchError);
    const totals = sumByCurrency([parseMoney('100', 'USD'), parseMoney('1500000', 'UZS'), parseMoney('50.5', 'USD')]);
    expect(totals).toEqual({ USD: 15050n, UZS: 150000000n });
  });

  it('converts only with a sourced rate and rounds half away from zero', () => {
    const r = convertMoney(parseMoney('10.00', 'USD'), { from: 'USD', to: 'UZS', rate: '12650.555', rateDate: '2026-10-24', source: 'CBU' });
    expect(formatMoney(r)).toBe('126505.55');
    expect(() => convertMoney(parseMoney('1', 'USD'), { from: 'USD', to: 'UZS', rate: '1', rateDate: '', source: '' })).toThrow();
  });
});

describe('phone normalization', () => {
  it('accepts explicit international numbers', () => {
    expect(normalizePhone('+998 (90) 123-45-67')).toMatchObject({ status: 'ok', normalized: '+998901234567' });
    expect(normalizePhone('00971501234567')).toMatchObject({ status: 'ok', normalized: '+971501234567' });
  });

  it('does not silently assume +998 without a confirmed company rule', () => {
    expect(normalizePhone('90 123 45 67')).toMatchObject({ status: 'needs_review', original: '90 123 45 67' });
    expect(normalizePhone('901234567', { countryCode: '998', nationalLength: 9, confirmed: false }).status).toBe('needs_review');
    expect(normalizePhone('901234567', { countryCode: '998', nationalLength: 9, confirmed: true })).toMatchObject({
      status: 'ok',
      normalized: '+998901234567',
      appliedRule: 'company_rule',
    });
  });

  it('rejects invalid input', () => {
    expect(normalizePhone('').status).toBe('invalid');
    expect(normalizePhone('call me').status).toBe('invalid');
    expect(normalizePhone('+12').status).toBe('invalid');
  });
});
