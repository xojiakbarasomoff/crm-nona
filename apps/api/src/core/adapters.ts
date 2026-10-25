import type { Redis } from 'ioredis';
import {
  assertAdaptersAllowed,
  DemoMetaDirectClient,
  DemoMetaLeadsClient,
  DemoStore,
  GraphMetaDirectClient,
  GraphMetaLeadsClient,
  BuiltinTestScanner,
  ClamdScanner,
  LocalPrivateStorage,
  S3Storage,
  ManualFlightProvider,
  type MalwareScanner,
  type StorageDriver,
  RedisRateLimiter,
  type AdapterDescriptor,
  type FlightProvider,
  type MetaDirectClient,
  type MetaLeadsClient,
} from '@crm/integrations';
import type { AppConfig } from './config';

export interface Adapters {
  readonly mode: AppConfig['mode'];
  readonly demoStore: DemoStore | null;
  readonly limiter: RedisRateLimiter;
  readonly metaLeads: MetaLeadsClient;
  readonly metaDirect: MetaDirectClient;
  /** Real Instagram Direct client; used for connections whose mode is `live` (also while the rest of the app is in demo mode). */
  readonly metaDirectLive: MetaDirectClient | null;
  readonly flight: FlightProvider;
  readonly storage: StorageDriver;
  readonly scanner: MalwareScanner;
  descriptors(): AdapterDescriptor[];
}

export function buildAdapters(config: AppConfig, redis: Redis): Adapters {
  const limiter = new RedisRateLimiter(redis);
  const flight = new ManualFlightProvider();
  const storage: StorageDriver = config.storage.driver === 's3' ? new S3Storage(config.storage.s3) : new LocalPrivateStorage(config.storageDir);
  // TZ §21: files live in private object storage. A local directory is accepted only in demo mode.
  const storageDescriptor = { name: storage.descriptor.name, kind: storage.descriptor.kind === 'local' ? ('mock' as const) : ('live' as const) };
  const scanner: MalwareScanner = config.scanner.kind === 'clamav' ? new ClamdScanner(config.scanner.host, config.scanner.port) : new BuiltinTestScanner();
  // The builtin scanner only knows the EICAR test signature: it counts as a mock outside demo.
  const scannerDescriptor = { name: scanner.descriptor.name, kind: scanner.descriptor.kind === 'builtin' ? ('mock' as const) : ('live' as const) };

  if (config.mode === 'demo') {
    const store = new DemoStore(redis);
    const adapters: Adapters = {
      mode: config.mode,
      demoStore: store,
      limiter,
      metaLeads: new DemoMetaLeadsClient(store),
      metaDirect: new DemoMetaDirectClient(store),
      metaDirectLive: config.meta.graphVersion ? new GraphMetaDirectClient(config.meta.graphVersion, config.meta.directLogin) : null,
      flight,
      storage,
      scanner,
      descriptors: () => [adapters.metaLeads.descriptor, adapters.metaDirect.descriptor, { name: flight.name, kind: 'manual' }, scannerDescriptor, storageDescriptor],
    };
    return adapters;
  }

  const metaLeads = new GraphMetaLeadsClient(config.meta.graphVersion);
  const metaDirect = new GraphMetaDirectClient(config.meta.graphVersion, config.meta.directLogin);
  const adapters: Adapters = {
    mode: config.mode,
    demoStore: null,
    limiter,
    metaLeads,
    metaDirect,
    metaDirectLive: metaDirect,
    flight,
    storage,
    scanner,
    descriptors: () => [
      metaLeads.descriptor,
      metaDirect.descriptor,
      { name: flight.name, kind: 'manual' },
      scannerDescriptor,
      storageDescriptor,
    ],
  };
  assertAdaptersAllowed(config.mode, adapters.descriptors());
  return adapters;
}
