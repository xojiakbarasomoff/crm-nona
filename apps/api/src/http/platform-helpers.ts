import type { Capability } from '@crm/domain';
import { requireCap } from '../core/scope';
import type { UserActor } from '../core';

export { eventsChannel, forbidden, notFound, type ChangeEvent, type Core, type UserActor } from '../core';

export function requireCapOrThrow(actor: UserActor, cap: Capability) {
  requireCap(actor, cap);
}
