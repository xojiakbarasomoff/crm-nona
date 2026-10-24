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
  ManualFlightProvider,
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
  /** null when Direct is handled by a native amoCRM connector (we must not process it twice). */
  readonly amoChats: AmoChatsClient | null;
  readonly flight: FlightProvider;
  amoRest(conn: AmoConnectionRef): AmoRestClient;
  descriptors(): AdapterDescriptor[];
}

export type TokenProviderFactory = (connectionId: string) => AmoTokenProvider;

export function buildAdapters(config: AppConfig, redis: Redis, tokenProviderFor: TokenProviderFactory): Adapters {
  const limiter = new RedisRateLimiter(redis);
  const flight = new ManualFlightProvider();

  if (config.mode === 'demo') {
    const store = new DemoStore(redis);
    const amo = new DemoAmoRestClient(store);
    const adapters: Adapters = {
      mode: config.mode,
      demoStore: store,
      limiter,
      metaLeads: new DemoMetaLeadsClient(store),
      metaDirect: new DemoMetaDirectClient(store),
      amoChats: config.directChannelMode === 'custom_channel' ? new DemoAmoChatsClient(store) : null,
      flight,
      amoRest: () => amo,
      descriptors: () => [amo.descriptor, adapters.metaLeads.descriptor, adapters.metaDirect.descriptor, ...(adapters.amoChats ? [adapters.amoChats.descriptor] : []), { name: flight.name, kind: 'manual' }],
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
    amoChats,
    flight,
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
    ],
  };
  assertAdaptersAllowed(config.mode, adapters.descriptors());
  return adapters;
}
