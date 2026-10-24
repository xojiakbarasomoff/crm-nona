/**
 * Application error shape (TZ §18.2): error.code, user-facing message, optional field_errors.
 * Status codes 401/403/404/409/422/429 are kept distinct. Foreign objects return 404 so that their
 * existence is not disclosed.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Obyekt') => new AppError(404, 'NOT_FOUND', `${what} topilmadi`);
export const forbidden = (message = 'Bu amal uchun huquqingiz yo‘q') => new AppError(403, 'FORBIDDEN', message);
export const unauthorized = (message = 'Tizimga kiring') => new AppError(401, 'UNAUTHORIZED', message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, undefined, details);
export const unprocessable = (code: string, message: string, fieldErrors?: Record<string, string>, details?: Record<string, unknown>) =>
  new AppError(422, code, message, fieldErrors, details);
export const tooMany = (message = 'Juda ko‘p urinish. Keyinroq qayta urinib ko‘ring') => new AppError(429, 'RATE_LIMITED', message);

export function isUniqueViolation(err: unknown, target?: string): boolean {
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e?.code !== 'P2002') return false;
  if (!target) return true;
  const t = e.meta?.target;
  return Array.isArray(t) ? t.join(',').includes(target) : typeof t === 'string' ? t.includes(target) : true;
}

/** Raw SQL unique violation (Postgres 23505), e.g. from partial unique indexes. */
export function isPgUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; meta?: { code?: string; message?: string }; message?: string };
  const pgCode = e?.meta?.code ?? (e?.code === 'P2010' ? undefined : e?.code);
  const msg = `${e?.message ?? ''} ${e?.meta?.message ?? ''}`;
  const isUnique = pgCode === '23505' || e?.code === 'P2002' || /23505|unique constraint/i.test(msg);
  if (!isUnique) return false;
  return constraint ? msg.includes(constraint) || e?.code === 'P2002' : true;
}
