import type { Redis } from 'ioredis';

import type { Config } from './config/env.js';
import { createAccountsModule, type AccountsApi } from './modules/accounts/index.js';
import { createAlertsModule, type AlertsApi } from './modules/alerts/index.js';
import { createMediaModule, type MediaApi } from './modules/media/index.js';
import { createEventsModule, type EventsApi } from './modules/events/index.js';
import { createBannersModule, type BannersApi } from './modules/banners/index.js';
import { createPublicRestosModule, type PublicRestosApi } from './modules/public-restos/index.js';
import { createLostModule, TesseractCardReader, type CardReader, type LostApi } from './modules/lost/index.js';
import { createCommerceModule, type CommerceApi } from './modules/commerce/index.js';
import { createPlacesModule, type PlacesApi } from './modules/places/index.js';
import { createAuditModule, type AuditApi } from './modules/audit/index.js';
import { createIdentityModule, type IdentityApi } from './modules/identity/index.js';
import { createOrganizationsModule, type OrganizationsApi } from './modules/organizations/index.js';
import { createCaravansModule, type CaravansApi } from './modules/caravans/index.js';
import { createMessagingModule, type MessagingApi } from './modules/messaging/index.js';
import { createNotificationsModule, type NotificationsApi } from './modules/notifications/index.js';
import { createPaymentsModule, type PaymentsApi } from './modules/payments/index.js';
import { createTaxiModule, type TaxiApi } from './modules/taxi/index.js';
import { createTicketingModule, type TicketingApi } from './modules/ticketing/index.js';
import { SessionDenylist } from './platform/auth/auth.js';
import { systemClock, type Clock } from './platform/clock.js';
import { connectMongo, type Mongo } from './platform/db/mongo.js';
import { Queues, redisConnection } from './platform/queue/queues.js';
import { RealtimeHub } from './platform/realtime/hub.js';
import { createRedis } from './platform/redis.js';
import { Limiter } from './platform/security/limiter.js';
import { TokenService } from './platform/security/tokens.js';

export type Container = {
  config: Config;
  clock: Clock;
  mongo: Mongo;
  redis: Redis;
  queues: Queues;
  tokens: TokenService;
  denylist: SessionDenylist;
  hub: RealtimeHub;
  modules: { audit: AuditApi; accounts: AccountsApi; organizations: OrganizationsApi; identity: IdentityApi; payments: PaymentsApi; messaging: MessagingApi; taxi: TaxiApi; ticketing: TicketingApi; caravans: CaravansApi; notifications: NotificationsApi; alerts: AlertsApi; publicRestos: PublicRestosApi; media: MediaApi; events: EventsApi; banners: BannersApi; lost: LostApi; commerce: CommerceApi; places: PlacesApi };
  close(): Promise<void>;
};

/** Composition root: builds infrastructure, then modules in dependency order, by hand (no DI framework). */
export async function createContainer(config: Config, opts: { clock?: Clock; warn?: (msg: string) => void; cardReader?: CardReader } = {}): Promise<Container> {
  const clock = opts.clock ?? systemClock;
  const mongo = await connectMongo(config.MONGODB_URI, config.MONGODB_DB);
  const redis = createRedis(config.REDIS_URL);
  const queues = new Queues(redisConnection(config.REDIS_URL), config.REDIS_PREFIX);
  const limiter = new Limiter(redis, config.REDIS_PREFIX, config.RATE_LIMIT_SCALE);
  const tokens = new TokenService(config, clock, () =>
    opts.warn?.('JWT keys not configured: using ephemeral keys (tokens are lost on restart). Run `npm run keys`.'),
  );
  const denylist = new SessionDenylist(redis, config.REDIS_PREFIX, tokens.accessTtlS);
  const hub = new RealtimeHub(redis, config.REDIS_URL, config.REDIS_PREFIX);

  const audit = createAuditModule(mongo.db, clock);
  // accounts needs organization memberships for /me, organizations needs accounts: the port is resolved lazily.
  const late: { organizations?: OrganizationsApi } = {};
  const accounts = createAccountsModule({ db: mongo.db, clock, audit, organizations: () => late.organizations! });
  const organizations = (late.organizations = createOrganizationsModule({ db: mongo.db, clock, accounts, audit }));
  const identity = createIdentityModule({ db: mongo.db, mongo: mongo.client, config, clock, queues, limiter, tokens, denylist, accounts, audit });
  const notifications = createNotificationsModule({ db: mongo.db, clock, hub, queues, accounts, config });
  const payments = createPaymentsModule({ db: mongo.db, mongo: mongo.client, clock, config, queues, accounts, notifications });
  const messaging = createMessagingModule({ db: mongo.db, clock, hub, limiter, audit, notifications });
  const ticketing = createTicketingModule({ db: mongo.db, mongo: mongo.client, clock, tokens, accounts, organizations, payments, hub, limiter, audit, notifications });
  const caravans = createCaravansModule({ db: mongo.db, mongo: mongo.client, clock, accounts, organizations, payments, ticketing, hub, limiter, audit, notifications });
  const taxi = createTaxiModule({ db: mongo.db, mongo: mongo.client, clock, config, accounts, payments, messaging, limiter, notifications });
  const media = createMediaModule({ db: mongo.db, clock, config, limiter });
  const events = createEventsModule({ db: mongo.db, mongo: mongo.client, clock, accounts, organizations, payments, ticketing, media, limiter, audit, notifications });
  const banners = createBannersModule({ db: mongo.db, mongo: mongo.client, clock, payments, media, events, organizations, limiter, audit, notifications });
  const alerts = createAlertsModule({ db: mongo.db, clock, audit, notifications, accounts });
  const publicRestos = createPublicRestosModule({ db: mongo.db, clock, audit, alerts, notifications });
  const commerce = createCommerceModule({ db: mongo.db, mongo: mongo.client, clock, accounts, organizations, payments, media, notifications, limiter, audit });
  const places = createPlacesModule({ db: mongo.db, clock, media, audit });
  const lost = createLostModule({
    db: mongo.db, mongo: mongo.client, clock, accounts, messaging, notifications, alerts, media, limiter, audit, reader: opts.cardReader ?? new TesseractCardReader(config.OCR_CACHE_DIR),
  });

  return {
    config,
    clock,
    mongo,
    redis,
    queues,
    tokens,
    denylist,
    hub,
    modules: { audit, accounts, organizations, identity, payments, messaging, taxi, ticketing, caravans, notifications, alerts, publicRestos, media, events, banners, lost, commerce, places },
    async close() {
      await lost.close();
      await hub.close();
      await queues.close();
      redis.disconnect();
      await mongo.client.close();
    },
  };
}
