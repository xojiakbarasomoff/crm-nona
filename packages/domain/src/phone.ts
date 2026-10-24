/**
 * Phone normalization to E.164 (TZ §7.1).
 * A number without an explicit country code is never silently interpreted as +998;
 * it either uses an explicitly confirmed company rule or is flagged for review.
 */

export interface CompanyPhoneRule {
  /** Country calling code without "+", e.g. "998". */
  countryCode: string;
  /** Expected national significant number length, e.g. 9 for Uzbekistan. */
  nationalLength: number;
  /** The rule must be confirmed by an administrator before it is applied. */
  confirmed: boolean;
}

export type PhoneNormalization =
  | { status: 'ok'; normalized: string; original: string; appliedRule: 'explicit' | 'company_rule' }
  | { status: 'needs_review'; normalized: null; original: string; reason: 'missing_country_code' }
  | { status: 'invalid'; normalized: null; original: string; reason: 'empty' | 'bad_length' | 'bad_characters' };

const ALLOWED = /^[\d\s()+\-.]+$/;

export function normalizePhone(raw: string | null | undefined, rule?: CompanyPhoneRule | null): PhoneNormalization {
  const original = (raw ?? '').trim();
  if (!original) return { status: 'invalid', normalized: null, original, reason: 'empty' };
  if (!ALLOWED.test(original)) return { status: 'invalid', normalized: null, original, reason: 'bad_characters' };

  const digits = original.replace(/\D/g, '');
  let international: string | null = null;
  if (original.startsWith('+')) international = digits;
  else if (digits.startsWith('00')) international = digits.slice(2);

  if (international !== null) {
    if (international.length < 8 || international.length > 15 || international.startsWith('0')) {
      return { status: 'invalid', normalized: null, original, reason: 'bad_length' };
    }
    return { status: 'ok', normalized: `+${international}`, original, appliedRule: 'explicit' };
  }

  if (rule?.confirmed) {
    const national = digits.replace(/^0+/, '');
    if (national.length === rule.nationalLength) {
      return { status: 'ok', normalized: `+${rule.countryCode}${national}`, original, appliedRule: 'company_rule' };
    }
    if (national.length === rule.countryCode.length + rule.nationalLength && national.startsWith(rule.countryCode)) {
      return { status: 'ok', normalized: `+${national}`, original, appliedRule: 'company_rule' };
    }
    return { status: 'invalid', normalized: null, original, reason: 'bad_length' };
  }

  return { status: 'needs_review', normalized: null, original, reason: 'missing_country_code' };
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}
