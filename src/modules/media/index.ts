import multipart from '@fastify/multipart';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { Type } from 'typebox';

import type { Config } from '../../config/env.js';
import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { Limiter } from '../../platform/security/limiter.js';
import { mediaCollections } from './media.collections.js';
import { MediaService } from './media.service.js';
import { createMediaStorage, LocalMediaStorage } from './media.storage.js';
import { MEDIA_PURPOSES } from './media.types.js';

export { mediaCollections };

/** Uploaded files above this are refused before being read. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type MediaApi = Pick<MediaService, 'claim'> & {
  registerRoutes(app: FastifyInstance): Promise<void>;
  /** Tests. */
  service: MediaService;
};

export function createMediaModule(d: { db: Db; clock: Clock; config: Config; limiter: Limiter }): MediaApi {
  const storage = createMediaStorage(d.config);
  const service = new MediaService(d.db, d.clock, storage, d.limiter);
  const apiBase = (req: FastifyRequest) => d.config.PUBLIC_API_URL ?? `${req.protocol}://${req.host}/api/v1`;

  const registerRoutes = async (root: FastifyInstance) => {
    await root.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 } });
    const app = root.withTypeProvider<TypeBoxTypeProvider>();

    app.post(
      '/media/images',
      {
        preHandler: requireAuth,
        schema: {
          tags: ['media'],
          consumes: ['multipart/form-data'],
          description: 'Upload one picture (field `file`, up to 10 MB: JPEG, PNG, WebP, HEIC). It comes back re-encoded (WebP, ≤ 1600 px, no metadata); attach it by `id`.',
          querystring: Type.Object({ purpose: Type.Enum(MEDIA_PURPOSES) }, { additionalProperties: false }),
          response: { 201: Type.Object({ id: Type.String(), url: Type.String(), width: Type.Number(), height: Type.Number() }) },
        },
      },
      async (req, reply) => {
        const file = await req.file();
        if (!file) throw errors.validation('Ajoute une image.', { field: 'file' });
        const buf = await file.toBuffer().catch(() => {
          throw errors.validation('Image trop lourde : 10 Mo au plus.', { field: 'file' });
        });
        const doc = await service.upload(toObjectId(actorOf(req).userId), req.query.purpose, buf, apiBase(req));
        return reply.status(201).send({ id: doc._id.toHexString(), url: doc.url, width: doc.width, height: doc.height });
      },
    );

    // Development: the files themselves (production serves them from the bucket's domain).
    if (storage instanceof LocalMediaStorage) {
      app.get('/media/*', { schema: { hide: true } }, async (req, reply) => {
        const body = await storage.read((req.params as { '*': string })['*']);
        if (!body) throw errors.notFound();
        return reply.header('content-type', 'image/webp').header('cache-control', 'public, max-age=31536000, immutable').send(body);
      });
    }
  };

  return { claim: (o, ids) => service.claim(o, ids), registerRoutes, service };
}
