/**
 * Money is stored as integer minor units (bigint) together with an ISO 4217 code.
 * Floating point is never used. Different currencies are never added together
 * without an explicit conversion rule (TZ §12.3, §15.1).
 */

export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  UZS: 2,
  USD: 2,
  EUR: 2,
  RUB: 2,
  KZT: 2,
  TRY: 2,
  AED: 2,
};

export type CurrencyCode = string;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} and ${b} without an explicit conversion rate`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export function currencyExponent(currency: string): number {
  const exp = CURRENCY_EXPONENT[currency];
  if (exp === undefined) throw new InvalidMoneyError(`Unsupported currency: ${currency}`);
  return exp;
}

export function isSupportedCurrency(currency: string): boolean {
  return CURRENCY_EXPONENT[currency] !== undefined;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parses a decimal string such as "1234.50" into minor units. Rejects excess precision. */
export function parseMoney(value: string, currency: string): Money {
  const exp = currencyExponent(currency);
  const trimmed = value.trim();
  const m = DECIMAL_RE.exec(trimmed);
  if (!m) throw new InvalidMoneyError(`Invalid decimal amount: "${value}"`);
  const [, sign, intPart = '0', fracRaw = ''] = m;
  if (fracRaw.length > exp) {
    throw new InvalidMoneyError(`Amount "${value}" has more than ${exp} fractional digits for ${currency}`);
  }
  const frac = fracRaw.padEnd(exp, '0');
  let minor = BigInt(intPart) * 10n ** BigInt(exp) + (frac ? BigInt(frac) : 0n);
  if (sign) minor = -minor;
  return { amountMinor: minor, currency };
}

/** Formats minor units as a plain decimal string ("1234.50"). */
export function formatMoney(money: Money): string {
  const exp = currencyExponent(money.currency);
  const negative = money.amountMinor < 0n;
  const abs = negative ? -money.amountMinor : money.amountMinor;
  const s = abs.toString().padStart(exp + 1, '0');
  const int = s.slice(0, s.length - exp);
  const frac = exp > 0 ? `.${s.slice(s.length - exp)}` : '';
  return `${negative ? '-' : ''}${int}${frac}`;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

/** Groups and sums amounts per currency. Never produces a cross-currency total. */
export function sumByCurrency(items: Iterable<Money>): Record<string, bigint> {
  const totals: Record<string, bigint> = {};
  for (const item of items) {
    currencyExponent(item.currency);
    totals[item.currency] = (totals[item.currency] ?? 0n) + item.amountMinor;
  }
  return totals;
}

export function assertNonNegative(money: Money): void {
  if (money.amountMinor < 0n) throw new InvalidMoneyError('Amount must not be negative');
}

export interface ConversionRate {
  readonly from: string;
  readonly to: string;
  /** Rate as decimal string, e.g. "12650.00" UZS per USD. */
  readonly rate: string;
  readonly rateDate: string;
  readonly source: string;
}

/**
 * Converts using an explicit, sourced rate. Rounds half away from zero to the
 * target currency's minor unit. Callers must persist the rate, date and source.
 */
export function convertMoney(money: Money, rate: ConversionRate): Money {
  if (money.currency !== rate.from) throw new CurrencyMismatchError(money.currency, rate.from);
  if (!rate.source || !rate.rateDate) throw new InvalidMoneyError('Conversion requires rate source and date');
  const m = DECIMAL_RE.exec(rate.rate);
  if (!m || m[1]) throw new InvalidMoneyError(`Invalid rate: ${rate.rate}`);
  const rateFrac = m[3] ?? '';
  const rateScaled = BigInt(`${m[2]}${rateFrac}`);
  const rateScale = 10n ** BigInt(rateFrac.length);
  const fromExp = 10n ** BigInt(currencyExponent(rate.from));
  const toExp = 10n ** BigInt(currencyExponent(rate.to));
  const numerator = money.amountMinor * rateScaled * toExp;
  const denominator = rateScale * fromExp;
  const negative = numerator < 0n;
  const absNum = negative ? -numerator : numerator;
  let q = absNum / denominator;
  if ((absNum % denominator) * 2n >= denominator) q += 1n;
  return { amountMinor: negative ? -q : q, currency: rate.to };
}
