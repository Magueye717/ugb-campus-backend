import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { errors } from '../../platform/http/errors.js';
import { IdParams, Nullable, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import type { LostService } from './lost.service.js';
import { CARD_TYPES } from './lost.ocr.js';
import { CLAIM_ROLES, LOST_CATEGORIES, LOST_HOLDERS, LOST_STATUSES, LOST_WHEN } from './lost.types.js';

const ItemView = Type.Object({
  id: Type.String(),
  status: Type.String({ description: LOST_STATUSES.join(' | ') }),
  kind: Type.String({ description: 'object | student-card | id-card (cards: never a photo)' }),
  category: Type.String({ description: LOST_CATEGORIES.join(' | ') }),
  name: Type.String(),
  details: Nullable(Type.String()),
  where: Type.String(),
  spot: Nullable(Type.String()),
  when: Type.String({ description: LOST_WHEN.join(' | ') }),
  holder: Nullable(Type.String({ description: 'Found items: office | finder' })),
  photo: Nullable(Type.String()),
  by: Type.String({ description: 'The declarer, masked: "Moussa S."' }),
  owner: Nullable(Type.String({ description: 'Cards: the owner, masked ("Awa D."). Never the number.' })),
  ownerNotified: Type.Boolean(),
  state: Type.String({ description: 'open | returned' }),
  returned: Type.Boolean(),
  createdAt: Type.String(),
  mine: Type.Boolean({ description: 'I declared it.' }),
  isOwner: Type.Boolean({ description: 'It’s my student card, found by someone.' }),
  secret: Nullable(Type.String({ description: 'Found objects, declarer only: the detail to check.' })),
  myClaimId: Nullable(Type.String({ description: 'My conversation about it (open /lost/claims/:id).' })),
  conversationsCount: Type.Number({ description: 'Declarer: conversations opened about it.' }),
});
const ItemDetail = Type.Object({
  ...ItemView.properties,
  conversations: Type.Array(Type.Object({ claimId: Type.String(), with: Type.String(), role: Type.String({ description: CLAIM_ROLES.join(' | ') }), createdAt: Type.String() }), { description: 'Declarer only.' }),
});
const ClaimView = Type.Object({
  id: Type.String(),
  role: Type.String({ description: 'claim (says it’s theirs) | found_it (found a lost item) | card (owner of a found student card)' }),
  conversationId: Nullable(Type.String({ description: 'Use the /conversations endpoints (messages, read, report, block).' })),
  with: Type.String(),
  item: ItemView,
});
const StudentMatch = Type.Object({
  ref: Type.String({ description: 'Send it back as ownerRef.' }),
  name: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  initials: Type.String(),
  ufr: Nullable(Type.String()),
  campus: Nullable(Type.String({ description: 'Students only.' })),
  village: Nullable(Type.String()),
  numberHint: Nullable(Type.String({ description: 'Students: "P23•••55", to compare with the card in hand.' })),
});

type Deps = { service: LostService; audit: AuditApi; requireStudent: preHandlerHookHandler; requireOffice: preHandlerHookHandler };

export function registerLostRoutes(root: FastifyInstance, { service, audit, requireStudent, requireOffice }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['lost'];
  const student = { preHandler: [requireAuth, requireStudent] };
  const trace = (req: FastifyRequest, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'lost_item', id }, requestId: req.id, ...(metadata ? { metadata } : {}) });

  // ---- The board ---------------------------------------------------------------------------------------------------

  app.get('/lost/items', { ...student, schema: { tags, description: 'Open items, those returned this week, and all of mine, newest first.', response: { 200: Type.Object({ items: Type.Array(ItemView) }) } } }, async (req) => ({
    items: await service.list(me(req)),
  }));

  app.get('/lost/items/:id', { ...student, schema: { tags, params: IdParams, response: { 200: ItemDetail } } }, async (req) => service.detail(toObjectId(req.params.id), me(req)));

  app.post(
    '/lost/items',
    {
      ...student,
      schema: {
        tags,
        description: 'Declare a lost or found object or card. Found objects need a photo (POST /media/images?purpose=lost); cards never have one; a found student card goes through /lost/cards/found.',
        body: Type.Object(
          {
            status: Type.Enum(LOST_STATUSES),
            category: Type.Enum(LOST_CATEGORIES),
            name: Type.Optional(Type.String({ maxLength: 40 })),
            details: Type.Optional(Nullable(Type.String({ maxLength: 80 }))),
            secret: Type.Optional(Nullable(Type.String({ maxLength: 80, description: 'Found objects: private, to check the owner.' }))),
            where: Type.String({ minLength: 1, maxLength: 40 }),
            spot: Type.Optional(Nullable(Type.String({ maxLength: 60 }))),
            when: Type.Enum(LOST_WHEN),
            holder: Type.Optional(Nullable(Type.Enum(LOST_HOLDERS))),
            imageId: Type.Optional(Nullable(ObjectIdString)),
            ownerName: Type.Optional(Nullable(Type.String({ maxLength: 30, description: 'Identity cards: the name read on it ("Mariama S.").' }))),
          },
          { additionalProperties: false },
        ),
        response: { 201: ItemDetail },
      },
    },
    async (req, reply) => {
      const doc = await service.declare(me(req), req.body);
      await trace(req, 'lost.declare', doc._id.toHexString(), { status: doc.status, category: doc.category });
      return reply.status(201).send(await service.detail(doc._id, me(req)));
    },
  );

  app.post('/lost/items/:id/returned', { ...student, schema: { tags, params: IdParams, description: 'Given back / found again: closes the item and its conversations.', response: { 200: ItemDetail } } }, async (req) => {
    await service.markReturned(toObjectId(req.params.id), { userId: me(req), office: false });
    await trace(req, 'lost.returned', req.params.id);
    return service.detail(toObjectId(req.params.id), me(req));
  });

  // ---- Conversations (messages go through /conversations/:conversationId) ------------------------------------------

  app.post(
    '/lost/items/:id/claim',
    {
      ...student,
      schema: {
        tags,
        params: IdParams,
        description: '"C’est à moi" on a found object kept by its finder: opens the conversation with my proof.',
        body: Type.Object({ proof: Type.String({ minLength: 3, maxLength: 140 }) }, { additionalProperties: false }),
        response: { 200: ClaimView },
      },
    },
    async (req) => {
      const claim = await service.claim(me(req), toObjectId(req.params.id), req.body.proof);
      return service.claimView(claim._id, me(req));
    },
  );

  app.post('/lost/items/:id/found-it', { ...student, schema: { tags, params: IdParams, description: '"Je l’ai trouvé" on a lost item: opens the conversation with its owner.', response: { 200: ClaimView } } }, async (req) => {
    const claim = await service.foundIt(me(req), toObjectId(req.params.id));
    return service.claimView(claim._id, me(req));
  });

  app.get('/lost/claims/:id', { ...student, schema: { tags, params: IdParams, description: 'A conversation about an item: the item, who it’s with, the conversation id.', response: { 200: ClaimView } } }, async (req) =>
    service.claimView(toObjectId(req.params.id), me(req)),
  );

  // ---- Found student cards -----------------------------------------------------------------------------------------

  app.post(
    '/lost/cards/read',
    {
      ...student,
      schema: {
        tags,
        consumes: ['multipart/form-data'],
        description: 'A photo of a found card (field `file`): OCR tells its type (student, national_id, driving_licence, bank), a student card’s number (P232055) and the names. Read in memory, never stored.',
        response: { 200: Type.Object({ cardType: Nullable(Type.String({ description: `${CARD_TYPES.join(' | ')}; null: not recognised` })), studentNumber: Nullable(Type.String()), names: Type.Array(Type.String()), owner: Nullable(StudentMatch), candidates: Type.Array(StudentMatch, { description: 'No number match: students with the names read.' }) }) },
      },
    },
    async (req) => {
      const file = await req.file();
      if (!file) throw errors.validation('Ajoute la photo de la carte.', { field: 'file' });
      const buf = await file.toBuffer().catch(() => {
        throw errors.validation('Photo trop lourde : 10 Mo au plus.', { field: 'file' });
      });
      return service.readCard(me(req), buf);
    },
  );

  app.post(
    '/me/student-card/read',
    {
      ...student,
      schema: {
        tags: ['me'],
        consumes: ['multipart/form-data'],
        description: 'A photo of my own student card (field `file`): birth date, place of birth and nationality, to check and then save with PUT /me/identity. Only my card (number, or names). Never stored.',
        response: {
          200: Type.Object({
            matched: Type.String({ description: 'number | name' }),
            studentNumber: Nullable(Type.String()),
            birthDate: Nullable(Type.String({ description: 'YYYY-MM-DD' })),
            birthPlace: Nullable(Type.String()),
            nationality: Nullable(Type.String()),
          }),
        },
      },
    },
    async (req) => {
      const file = await req.file();
      if (!file) throw errors.validation('Ajoute la photo de ta carte.', { field: 'file' });
      const buf = await file.toBuffer().catch(() => {
        throw errors.validation('Photo trop lourde : 10 Mo au plus.', { field: 'file' });
      });
      return service.readMyCard(me(req), buf);
    },
  );

  app.get(
    '/lost/cards/lookup',
    { ...student, schema: { tags, querystring: Type.Object({ number: Type.String({ maxLength: 30 }) }, { additionalProperties: false }), response: { 200: Type.Object({ studentNumber: Type.String(), owner: Nullable(StudentMatch) }) } } },
    async (req) => service.lookupCard(me(req), req.query.number),
  );

  app.get(
    '/lost/cards/search',
    { ...student, schema: { tags, description: 'By name, when the number can’t be read.', querystring: Type.Object({ q: Type.String({ minLength: 2, maxLength: 60 }) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(StudentMatch) }) } } },
    async (req) => ({ items: await service.searchCardOwners(me(req), req.query.q) }),
  );

  app.post(
    '/lost/cards/found',
    {
      ...student,
      schema: {
        tags,
        description: 'Declares the found card. Its owner (ownerRef from read/lookup/search) gets a push and a home alert with the finder’s name and phone, and a chat. Unknown owner: null, it goes to the office.',
        body: Type.Object(
          { ownerRef: Nullable(ObjectIdString), cardType: Type.Optional(Nullable(Type.Enum(CARD_TYPES, { description: 'Default student.' }))), where: Type.String({ minLength: 1, maxLength: 40 }), spot: Type.Optional(Nullable(Type.String({ maxLength: 60 }))), holder: Type.Enum(LOST_HOLDERS) },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ item: ItemDetail, claimId: Nullable(Type.String()) }) },
      },
    },
    async (req, reply) => {
      const { item, claimId } = await service.cardFound(me(req), req.body);
      await trace(req, 'lost.card_found', item._id.toHexString(), { ownerNotified: !!item.owner });
      return reply.status(201).send({ item: await service.detail(item._id, me(req)), claimId });
    },
  );

  // ---- Lost and found office ---------------------------------------------------------------------------------------

  const office = { preHandler: [requireAuth, requireOffice] };
  app.get(
    '/admin/lost/items',
    {
      ...office,
      schema: {
        tags,
        description: 'What the office holds or should receive; cards with the owner’s name and phone to check at the desk.',
        response: {
          200: Type.Object({
            items: Type.Array(
              Type.Object({
                id: Type.String(), category: Type.String(), kind: Type.String(), name: Type.String(), details: Nullable(Type.String()), where: Type.String(), photo: Nullable(Type.String()), by: Type.String(),
                owner: Nullable(Type.Object({ name: Type.String(), phone: Nullable(Type.String()) })), createdAt: Type.String(),
              }),
            ),
          }),
        },
      },
    },
    async () => ({ items: await service.atOffice() }),
  );

  app.post('/admin/lost/items/:id/handed-over', { ...office, schema: { tags, params: IdParams, description: 'Given back at the desk.' } }, async (req, reply) => {
    await service.markReturned(toObjectId(req.params.id), { userId: me(req), office: true });
    await trace(req, 'lost.handed_over', req.params.id);
    return reply.status(204).send();
  });
}
