/**
 * Role matrix (TZ §6.1). Object-level checks are applied in backend queries; this module only
 * describes capabilities so that API, export, SSE and UI read from one source.
 */

export const ROLES = ['ADMIN', 'MANAGER', 'USER'] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | 'integrations.manage'
  | 'users.manage'
  | 'records.view_all'
  | 'records.edit_all'
  | 'leads.reassign'
  | 'export'
  | 'audit.read_all'
  | 'audit.read_own'
  | 'dashboard.company'
  | 'reminders.assign_others'
  | 'leads.reopen'
  | 'integrations.replay'
  | 'reference.view_full'
  | 'suppliers.manage'
  /** Tannarx (net price), foyda va yetkazib beruvchi qaytarimlarini ko‘rish/kiritish. Administratorda standart; menejerga administrator shaxsiy yoqadi. */
  | 'finance.cost.view';

const MATRIX: Record<Role, ReadonlySet<Capability>> = {
  ADMIN: new Set<Capability>([
    'integrations.manage',
    'users.manage',
    'records.view_all',
    'records.edit_all',
    'leads.reassign',
    'export',
    'audit.read_all',
    'dashboard.company',
    'reminders.assign_others',
    'leads.reopen',
    'integrations.replay',
    'reference.view_full',
    'suppliers.manage',
    'finance.cost.view',
  ]),
  MANAGER: new Set<Capability>(['audit.read_own']),
  /** Faqat o‘qish: o‘ziga biriktirilgan ma’lumotlar. Server har qanday yozuvchi so‘rovni rad etadi (`isReadOnlyRole`). */
  USER: new Set<Capability>([]),
};

/** Faqat o‘qish roli: GET/HEAD dan boshqa so‘rovlar server tomonida rad etiladi. */
export function isReadOnlyRole(role: Role): boolean {
  return role === 'USER';
}

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[role].has(cap);
}

export function capabilitiesOf(role: Role): Capability[] {
  return [...MATRIX[role]];
}

/** Rolga qo‘shimcha, administrator shaxsiy yoqadigan huquqlar (DB: users.extra_capabilities). */
export const GRANTABLE_CAPABILITIES = ['finance.cost.view'] as const satisfies readonly Capability[];
export type GrantableCapability = (typeof GRANTABLE_CAPABILITIES)[number];

export interface CapabilityHolder {
  role: Role;
  extraCapabilities?: readonly string[];
}

/** Rol huquqi YOKI shaxsiy qo‘shimcha huquq. Tannarx/foyda tekshiruvi har doim shu funksiya orqali. */
export function canWith(user: CapabilityHolder, cap: Capability): boolean {
  // Shaxsiy yozuv faqat berilishi mumkin bo‘lgan huquqlar uchun amal qiladi (boshqasi — DB CHECK va bu yerda rad etiladi).
  return can(user.role, cap) || ((GRANTABLE_CAPABILITIES as readonly string[]).includes(cap) && (user.extraCapabilities?.includes(cap) ?? false));
}

export function capabilitiesFor(user: CapabilityHolder): Capability[] {
  const extra = (GRANTABLE_CAPABILITIES as readonly string[]).filter((c) => user.extraCapabilities?.includes(c)) as Capability[];
  return [...new Set([...capabilitiesOf(user.role), ...extra])];
}

/** Managers see only records they own. Returns the owner filter to add to every query, or null. */
export function ownerScope(user: { id: string; role: Role }): string | null {
  return can(user.role, 'records.view_all') ? null : user.id;
}
