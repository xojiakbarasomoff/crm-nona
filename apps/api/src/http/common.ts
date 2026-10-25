import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  CanActivate,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { CurrencyMismatchError, InvalidMoneyError, isReadOnlyRole, sha256Hex, userWriteAllowed, stableStringify } from '@crm/domain';
import { AppError, conflict, forbidden, notFound, unauthorized, unprocessable, type Core, type UserActor } from '../core';
import type { SessionInfo } from '../core/services/auth.service';

export const CORE = Symbol('CORE');
export const SESSION_COOKIE = 'crm_session';
export const CSRF_COOKIE = 'crm_csrf';

export interface AuthedRequest extends Request {
  requestId: string;
  actor?: UserActor;
  session?: SessionInfo;
  rawBody?: Buffer;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  (req as AuthedRequest).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export const PUBLIC = 'public_route';
export const Public = () => SetMetadata(PUBLIC, true);
/** Routes an admin may use before MFA is enrolled/verified. */
export const ALLOW_WITHOUT_MFA = 'allow_without_mfa';
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);

export const Actor = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.actor) throw unauthorized();
  return req.actor;
});

/**
 * Session + CSRF + MFA guard applied globally. Session validity (blocked user, revoked session)
 * is checked on every request — no caching of permissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CORE) private readonly core: Core,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const info = await this.core.auth.resolveSession(req.cookies?.[SESSION_COOKIE]);
    if (!info) throw unauthorized();
    req.actor = { ...info.actor, requestId: req.requestId, ip: req.ip ?? null };
    req.session = info;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const cookie = req.cookies?.[CSRF_COOKIE];
      const header = req.header('x-csrf-token');
      if (!cookie || !header || cookie !== header) throw new AppError(403, 'CSRF_FAILED', 'Ошибка проверки безопасности (CSRF). Обновите страницу.');
      // Роль «Пользователь»: только создание своих лидов, основные данные и заметки своих лидов; остальное отклоняется на сервере.
      if (isReadOnlyRole(info.actor.role) && !userWriteAllowed(req.method, req.path.replace(/^\/api\/v1/, ''))) {
        throw new AppError(403, 'READ_ONLY_ROLE', 'Для роли «Пользователь» это действие недоступно');
      }
    }
    const allowWithoutMfa = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_MFA, [ctx.getHandler(), ctx.getClass()]);
    if (info.mfaRequired && !info.mfaVerified && !allowWithoutMfa) {
      throw new AppError(403, info.mfaEnrolled ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED', 'Для администратора обязательна двухфакторная защита (MFA)');
    }
    return true;
  }
}

/** Error shape (TZ §18.2). Stack traces and provider tokens never leave the server. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly log: (o: object, msg: string) => void) {}
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<AuthedRequest>();
    const requestId = req.requestId ?? randomUUID();
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.fieldErrors ? { field_errors: err.fieldErrors } : {}), ...(err.details ? { details: err.details } : {}) }, request_id: requestId });
      return;
    }
    if (err instanceof InvalidMoneyError || err instanceof CurrencyMismatchError) {
      res.status(422).json({ error: { code: err instanceof InvalidMoneyError ? 'INVALID_AMOUNT' : 'CURRENCY_MISMATCH', message: err.message }, request_id: requestId });
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      res.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message: status === 404 ? 'Не найдено' : err.message }, request_id: requestId });
      return;
    }
    const pgDown = /Can't reach database|ECONNREFUSED|P1001|P1017|Connection terminated/i.test(String((err as Error)?.message));
    this.log({ requestId, err: (err as Error)?.message, path: req.path }, 'unhandled error');
    res.status(pgDown ? 503 : 500).json({ error: { code: pgDown ? 'SERVICE_UNAVAILABLE' : 'INTERNAL', message: 'Внутренняя ошибка. Повторите позже.' }, request_id: requestId });
  }
}

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of r.error.issues) fieldErrors[issue.path.join('.') || '_'] = issue.message;
  throw unprocessable('VALIDATION_FAILED', 'Введены неверные данные', fieldErrors);
}

export const toDate = (v: string | null | undefined) => (v ? new Date(v) : v === null ? null : undefined);

/**
 * Idempotency-Key handling (TZ §18.2): same key + same payload → stored response; same key with a
 * different payload → 409.
 */
export async function withIdempotency<T>(core: Core, actor: UserActor, req: AuthedRequest, required: boolean, fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T }> {
  const key = req.header('idempotency-key');
  if (!key) {
    if (required) throw unprocessable('IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    return fn();
  }
  if (!/^[\w-]{8,100}$/.test(key)) throw unprocessable('IDEMPOTENCY_KEY_INVALID', 'Неверный формат Idempotency-Key');
  const prisma = core.deps.prisma;
  const payloadHash = sha256Hex(stableStringify({ path: req.path, body: req.body }));
  const existing = await prisma.idempotencyKey.findUnique({ where: { companyId_userId_key: { companyId: actor.companyId, userId: actor.id, key } } });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Этот Idempotency-Key уже использован для другого запроса');
    if (existing.responseStatus) return { status: existing.responseStatus, body: existing.responseBody as T };
    throw conflict('IDEMPOTENCY_IN_PROGRESS', 'Запрос ещё выполняется');
  }
  await prisma.idempotencyKey.create({ data: { companyId: actor.companyId, userId: actor.id, key, method: req.method, path: req.path, payloadHash, expiresAt: new Date(Date.now() + 24 * 3600_000) } });
  try {
    const result = await fn();
    await prisma.idempotencyKey.update({ where: { companyId_userId_key: { companyId: actor.companyId, userId: actor.id, key } }, data: { responseStatus: result.status, responseBody: JSON.parse(jsonSafe(result.body)) } });
    return result;
  } catch (err) {
    await prisma.idempotencyKey.delete({ where: { companyId_userId_key: { companyId: actor.companyId, userId: actor.id, key } } }).catch(() => undefined);
    throw err;
  }
}

/** JSON with bigint → string. */
export function jsonSafe(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

export function send(res: Response, status: number, body: unknown) {
  res.status(status).type('application/json').send(jsonSafe(body));
}

export function requireDemo(core: Core) {
  if (core.deps.config.mode !== 'demo') throw forbidden('Доступно только в ДЕМО-режиме');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Malformed ids answer 404 like foreign ones (no existence oracle). */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(v: string) {
    if (!UUID_RE.test(v)) throw notFound();
    return v;
  }
}
