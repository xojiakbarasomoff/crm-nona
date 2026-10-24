/**
 * Role matrix (TZ §6.1). Object-level checks are applied in backend queries; this module only
 * describes capabilities so that API, export, SSE and UI read from one source.
 */

export const ROLES = ['ADMIN', 'HEAD', 'MANAGER'] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | 'integrations.manage'
  | 'users.manage'
  | 'records.view_all'
  | 'records.edit_all'
  | 'leads.reassign'
  | 'duplicates.resolve'
  | 'duplicates.flag'
  | 'export'
  | 'audit.read_all'
  | 'audit.read_own'
  | 'dashboard.company'
  | 'reminders.assign_others'
  | 'leads.reopen'
  | 'integrations.replay'
  | 'reference.view_full'
  | 'suppliers.manage';

const MATRIX: Record<Role, ReadonlySet<Capability>> = {
  ADMIN: new Set<Capability>([
    'integrations.manage',
    'users.manage',
    'records.view_all',
    'records.edit_all',
    'leads.reassign',
    'duplicates.resolve',
    'duplicates.flag',
    'export',
    'audit.read_all',
    'dashboard.company',
    'reminders.assign_others',
    'leads.reopen',
    'integrations.replay',
    'reference.view_full',
    'suppliers.manage',
  ]),
  HEAD: new Set<Capability>([
    'records.view_all',
    'records.edit_all',
    'leads.reassign',
    'duplicates.resolve',
    'duplicates.flag',
    'export',
    'audit.read_all',
    'dashboard.company',
    'reminders.assign_others',
    'leads.reopen',
    'reference.view_full',
    'suppliers.manage',
  ]),
  MANAGER: new Set<Capability>(['duplicates.flag', 'audit.read_own']),
};

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[role].has(cap);
}

export function capabilitiesOf(role: Role): Capability[] {
  return [...MATRIX[role]];
}

/** Managers see only records they own. Returns the owner filter to add to every query, or null. */
export function ownerScope(user: { id: string; role: Role }): string | null {
  return can(user.role, 'records.view_all') ? null : user.id;
}
