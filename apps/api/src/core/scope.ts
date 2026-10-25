import { can, canWith, ownerScope, type Capability } from '@crm/domain';
import type { Actor, UserActor } from './context';
import { forbidden, notFound } from './errors';

/**
 * Object-level access (TZ §6.1). Every query that returns business data composes these filters;
 * hiding buttons in the UI is never relied upon.
 */

export function requireCap(actor: Actor, cap: Capability): void {
  if (actor.type !== 'user') return;
  if (!can(actor.role, cap)) throw forbidden();
}

/** Tannarx, foyda va yetkazib beruvchi qaytarimlarini ko'rish/kiritish huquqi (rol yoki shaxsiy). Backend, dashboard va eksportda bir xil. */
export function canCost(actor: Actor): boolean {
  return actor.type !== 'user' || canWith(actor, 'finance.cost.view');
}

export function requireCost(actor: Actor): void {
  if (!canCost(actor)) throw forbidden('Tannarx va foydani ko‘rish/kiritish huquqingiz yo‘q');
}

export function isUser(actor: Actor): actor is UserActor {
  return actor.type === 'user';
}

/** Owner filter for leads / orders / segments; system actors see everything in the company. */
export function ownerFilter(actor: Actor): { ownerId?: string } {
  if (actor.type !== 'user') return {};
  const owner = ownerScope(actor);
  return owner ? { ownerId: owner } : {};
}

export function leadWhere(actor: Actor, extra: Record<string, unknown> = {}) {
  return { companyId: actor.companyId, deletedAt: null, ...ownerFilter(actor), ...extra };
}

export function orderWhere(actor: Actor, extra: Record<string, unknown> = {}) {
  return { companyId: actor.companyId, ...ownerFilter(actor), ...extra };
}

/** Throws 404 (not 403) when the object is outside the actor's scope, to avoid disclosing it. */
export function assertFound<T>(value: T | null | undefined, what?: string): T {
  if (value === null || value === undefined) throw notFound(what);
  return value;
}

export function canEditRecord(actor: Actor, ownerId: string | null): boolean {
  if (actor.type !== 'user') return true;
  if (can(actor.role, 'records.edit_all')) return true;
  return ownerId === actor.id;
}
