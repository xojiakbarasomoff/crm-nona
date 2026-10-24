/**
 * Runtime mode guard (TZ §25.1). Production must never run with a mock adapter.
 */
export type AppMode = 'demo' | 'staging' | 'production';

export function parseAppMode(value: string | undefined): AppMode {
  if (value === 'demo' || value === 'staging' || value === 'production') return value;
  throw new Error(`APP_MODE must be demo | staging | production (got "${value ?? ''}")`);
}

export interface AdapterDescriptor {
  name: string;
  kind: 'mock' | 'live' | 'manual';
}

export class MockAdapterInProductionError extends Error {
  constructor(names: string[]) {
    super(`Refusing to start: mock adapters configured in production: ${names.join(', ')}`);
    this.name = 'MockAdapterInProductionError';
  }
}

export function assertAdaptersAllowed(mode: AppMode, adapters: AdapterDescriptor[]): void {
  const mocks = adapters.filter((a) => a.kind === 'mock').map((a) => a.name);
  if (mode !== 'demo' && mocks.length) throw new MockAdapterInProductionError(mocks);
}
