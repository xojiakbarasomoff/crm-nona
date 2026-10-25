import type { Redis } from 'ioredis';
import {
  assertAdaptersAllowed,
  DemoAmoChatsClient,
  DemoAmoRestClient,
  DemoMetaDirectClient,
  DemoMetaLeadsClient,
  DemoStore,
  GraphMetaDirectClient,
  GraphMetaLeadsClient,
  LiveAmoChatsClient,
  LiveAmoRestClient,
  BuiltinTestScanner,
  ClamdScanner,
  LocalPrivateStorage,
  S3Storage,
  ManualFlightProvider,
  type MalwareScanner,
  type StorageDriver,
  RedisRateLimiter,
  type AdapterDescriptor,
  type AmoChatsClient,
  type AmoRestClient,
  type AmoTokenProvider,
  type FlightProvider,
  type MetaDirectClient,
  type MetaLeadsClient,
} from '@crm/integrations';
import type { AppConfig } from './config';

export interface AmoConnectionRef {
  id: string;
  accountDomain: string | null;
  accountId: string;
}

export interface Adapters {
  readonly mode: AppConfig['mode'];
  readonly demoStore: DemoStore | null;
  readonly limiter: RedisRateLimiter;
  readonly metaLeads: MetaLeadsClient;
  readonly metaDirect: MetaDirectClient;
  /** Real Instagram Direct client; used for connections whose mode is `live` (also while the rest of the app is in demo mode). */
  readonly metaDirectLive: MetaDirectClient | null;
  /** null when Direct is handled by a native amoCRM connector (we must not process it twice). */
  readonly amoChats: AmoChatsClient | null;
  readonly flight: FlightProvider;
  readonly storage: StorageDriver;
  readonly scanner: MalwareScanner;
  amoRest(conn: AmoConnectionRef): AmoRestClient;
  descriptors(): AdapterDescriptor[];
}

export type TokenProviderFactory = (connectionId: string) => AmoTokenProvider;

export function buildAdapters(config: AppConfig, redis: Redis, tokenProviderFor: TokenProviderFactory): Adapters {
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
    const amo = new DemoAmoRestClient(store);
    const adapters: Adapters = {
      mode: config.mode,
      demoStore: store,
      limiter,
      metaLeads: new DemoMetaLeadsClient(store),
      metaDirect: new DemoMetaDirectClient(store),
      metaDirectLive: config.meta.graphVersion ? new GraphMetaDirectClient(config.meta.graphVersion, config.meta.directLogin) : null,
      amoChats: config.directChannelMode === 'custom_channel' ? new DemoAmoChatsClient(store) : null,
      flight,
      storage,
      scanner,
      amoRest: () => amo,
      descriptors: () => [amo.descriptor, adapters.metaLeads.descriptor, adapters.metaDirect.descriptor, ...(adapters.amoChats ? [adapters.amoChats.descriptor] : []), { name: flight.name, kind: 'manual' }, scannerDescriptor, storageDescriptor],
    };
    return adapters;
  }

  const metaLeads = new GraphMetaLeadsClient(config.meta.graphVersion);
  const metaDirect = new GraphMetaDirectClient(config.meta.graphVersion, config.meta.directLogin);
  const amoChats = config.directChannelMode === 'custom_channel' ? new LiveAmoChatsClient({ channelId: config.amoChats.channelId, secret: config.amoChats.secret }) : null;
  const adapters: Adapters = {
    mode: config.mode,
    demoStore: null,
    limiter,
    metaLeads,
    metaDirect,
    metaDirectLive: metaDirect,
    amoChats,
    flight,
    storage,
    scanner,
    amoRest: (conn) => {
      if (!conn.accountDomain) throw new Error('amoCRM connection has no account domain');
      return new LiveAmoRestClient(conn.accountDomain, tokenProviderFor(conn.id), limiter, `amo:${conn.accountId}`, config.amo.rps);
    },
    descriptors: () => [
      { name: 'amocrm-rest-v4', kind: 'live' },
      metaLeads.descriptor,
      metaDirect.descriptor,
      ...(amoChats ? [amoChats.descriptor] : []),
      { name: flight.name, kind: 'manual' },
      scannerDescriptor,
      storageDescriptor,
    ],
  };
  assertAdaptersAllowed(config.mode, adapters.descriptors());
  return adapters;
}
