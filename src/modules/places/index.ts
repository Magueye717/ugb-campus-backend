import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { AuditApi } from '../audit/index.js';
import type { MediaApi, MediaUsage } from '../media/index.js';
import { placesCollections } from './places.collections.js';
import { registerPlacesRoutes } from './places.routes.js';
import { PlacesService } from './places.service.js';

export { placesCollections };

export type PlacesApi = {
  registerRoutes(app: FastifyInstance, requireEditor: preHandlerHookHandler): void;
  /** Tests and the seed. */
  service: PlacesService;
};

/** Campus places photos. The media module deletes a picture once none of these reference it. */
export const PLACES_MEDIA_USAGE: MediaUsage[] = [{ collection: 'places', path: 'photos.mediaId' }];

export function createPlacesModule(d: { db: Db; clock: Clock; media: MediaApi; audit: AuditApi }): PlacesApi {
  const service = new PlacesService(d.db, d.clock, d.media);
  return { registerRoutes: (app, requireEditor) => registerPlacesRoutes(app, { service, audit: d.audit, requireEditor }), service };
}
