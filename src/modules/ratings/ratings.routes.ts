import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, Nullable, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import { rateableView, type RatingsService } from './ratings.service.js';
import { RATING_SUBJECTS } from './ratings.types.js';

const RateableView = Type.Object({
  subject: Type.String({ description: RATING_SUBJECTS.join(' | ') }),
  id: Type.String(),
  title: Type.String({ description: '"UGB → Dakar", the event\'s title, "Commande chez Khoulé & Frère".' }),
  ratedName: Type.String({ description: 'Who is rated: the organizer, the restaurant or shop.' }),
  endedAt: Type.String(),
});
const Params = Type.Object({ subject: Type.Enum(RATING_SUBJECTS), id: ObjectIdString }, { additionalProperties: false });

export function registerRatingsRoutes(root: FastifyInstance, { service }: { service: RatingsService }) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const tags = ['ratings'];
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const auth = { preHandler: requireAuth };

  app.get(
    '/me/ratings/pending',
    { ...auth, schema: { tags, description: 'Services that ended lately and aren’t rated (nor declined, nor put off too often): what the app asks about, newest first.', response: { 200: Type.Object({ items: Type.Array(RateableView) }) } } },
    async (req) => ({ items: (await service.pending(me(req))).map(rateableView) }),
  );

  app.get(
    '/me/ratings/:subject/:id',
    { ...auth, schema: { tags, params: Params, description: 'A service page’s rating card. `rateable` null: not over yet, not taken part in, or too old.', response: { 200: Type.Object({ rateable: Nullable(RateableView), stars: Nullable(Type.Integer()), comment: Type.String() }) } } },
    async (req) => {
      const r = await service.mine(me(req), req.params.subject, toObjectId(req.params.id));
      return { ...r, rateable: r.rateable ? rateableView(r.rateable) : null };
    },
  );

  app.put(
    '/me/ratings/:subject/:id',
    {
      ...auth,
      schema: {
        tags,
        params: Params,
        description: 'Rates (or re-rates) it. The organizer’s or business’s average follows.',
        body: Type.Object({ stars: Type.Integer({ minimum: 1, maximum: 5 }), comment: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false }),
        response: { 200: Type.Object({ stars: Type.Integer(), comment: Type.String() }) },
      },
    },
    async (req) => {
      const d = await service.rate(me(req), req.params.subject, toObjectId(req.params.id), req.body.stars, req.body.comment);
      return { stars: d.stars!, comment: d.comment };
    },
  );

  app.get(
    '/businesses/:id/reviews',
    {
      ...auth,
      schema: {
        tags,
        params: IdParams,
        description: 'A restaurant’s or shop’s reviews, anonymous: average, count per star (5 to 1), the latest comments.',
        response: {
          200: Type.Object({
            avg: Nullable(Type.Number()),
            count: Type.Integer(),
            distribution: Type.Array(Type.Object({ stars: Type.Integer(), count: Type.Integer() })),
            comments: Type.Integer({ description: 'Ratings with a comment (the latest are in `items`).' }),
            items: Type.Array(Type.Object({ stars: Type.Integer(), comment: Type.String(), at: Type.String() })),
          }),
        },
      },
    },
    async (req) => service.reviews(toObjectId(req.params.id)),
  );

  app.post('/me/ratings/:subject/:id/later', { ...auth, schema: { tags, params: Params, description: '« Plus tard »: asked again, a few times at most.' } }, async (req, reply) => {
    await service.later(me(req), req.params.subject, toObjectId(req.params.id));
    return reply.status(204).send();
  });

  app.post('/me/ratings/:subject/:id/decline', { ...auth, schema: { tags, params: Params, description: '« Ne pas noter »: never asked again.' } }, async (req, reply) => {
    await service.decline(me(req), req.params.subject, toObjectId(req.params.id));
    return reply.status(204).send();
  });
}
