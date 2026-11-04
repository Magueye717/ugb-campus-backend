import { ObjectId, type Collection, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { NotificationsApi } from '../notifications/index.js';
import { ASK_WITHIN_DAYS, MAX_PROMPTS, RATE_WITHIN_DAYS, type Rateable, type RatingDoc, type RatingSubject } from './ratings.types.js';

const DAY = 24 * 3_600_000;
/** The worker asks for the services that ended this recently (older ones: too late to push). */
const PUSH_WITHIN = 2 * DAY;
/** The latest comments shown on a business's page. */
const REVIEWS_SHOWN = 30;

/** Where the rating is set: the averages shown on the cards. */
export type RatingTargets = {
  setOrgRating(orgId: ObjectId, avg: number | null, count: number): Promise<void>;
  setBusinessRating(businessId: ObjectId, avg: number | null, count: number): Promise<void>;
};

type Named = { _id: ObjectId; name: string };

export const rateableView = (r: Rateable) => ({ subject: r.subject, id: r.id.toHexString(), title: r.title, ratedName: r.ratedName, endedAt: r.endedAt.toISOString() });

/**
 * Ratings: after a caravan trip, an event, an order, the student may give 1 to 5 stars (and a word). It's optional:
 * the app asks while it's fresh (a few times at most), the service's page always offers it. Who took part is read from
 * the tickets (the traveller / attendee, not the buyer of a friend's seat) and from the orders.
 */
export class RatingsService {
  private readonly ratings: Collection<RatingDoc>;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly notifications: NotificationsApi,
    private readonly targets: RatingTargets,
  ) {
    this.ratings = db.collection('ratings');
  }

  // ---- What a student can rate -----------------------------------------------------------------------------------

  /** The services this student took part in that ended after `since`, newest first. */
  async ended(userId: ObjectId, since: Date, only?: { subject: RatingSubject; id: ObjectId }): Promise<Rateable[]> {
    const want = (s: RatingSubject) => !only || only.subject === s;
    const out: Rateable[] = [];
    const held = async (kind: 'caravan_seat' | 'event_entry') =>
      (await this.db.collection('tickets').find({ kind, holderUserId: userId, holderTravels: true, status: 'active', ...(only ? { eventId: only.id } : {}) }, { projection: { eventId: 1 } }).toArray()).map((t) => t.eventId as ObjectId);

    if (want('caravan')) {
      const ids = await held('caravan_seat');
      const trips = ids.length ? await this.db.collection('departures').find({ _id: { $in: ids }, status: 'completed', completedAt: { $gte: since } }).toArray() : [];
      const orgs = await this.names('organizations', trips.map((d) => d.orgId));
      for (const d of trips) out.push({ subject: 'caravan', id: d._id, orgId: d.orgId, businessId: null, title: `${d.from} → ${d.to}`, ratedName: orgs.get(d.orgId.toHexString()) ?? '', endedAt: d.completedAt });
    }
    if (want('event')) {
      const ids = await held('event_entry');
      const events = ids.length ? await this.db.collection('events').find({ _id: { $in: ids }, status: 'completed', completedAt: { $gte: since } }).toArray() : [];
      const orgs = await this.names('organizations', events.map((e) => e.orgId));
      for (const e of events) out.push({ subject: 'event', id: e._id, orgId: e.orgId, businessId: null, title: e.title, ratedName: orgs.get(e.orgId.toHexString()) ?? '', endedAt: e.completedAt });
    }
    if (want('order')) {
      const orders = await this.db.collection('commerceOrders').find({ userId, status: 'completed', updatedAt: { $gte: since }, ...(only ? { _id: only.id } : {}) }).toArray();
      const shops = await this.names('businesses', orders.map((o) => o.businessId));
      for (const o of orders) out.push({ subject: 'order', id: o._id, orgId: o.orgId, businessId: o.businessId, title: `Commande chez ${shops.get(o.businessId.toHexString()) ?? 'un commerce'}`, ratedName: shops.get(o.businessId.toHexString()) ?? '', endedAt: o.updatedAt });
    }
    return out.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
  }

  private async names(collection: string, ids: ObjectId[]) {
    if (!ids.length) return new Map<string, string>();
    const docs = await this.db.collection<Named>(collection).find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
    return new Map(docs.map((d) => [d._id.toHexString(), d.name]));
  }

  private since(days: number) {
    return new Date(this.clock.now().getTime() - days * DAY);
  }

  /** What to ask about now: ended lately, not rated, not declined, not put off too often. Newest first. */
  async pending(userId: ObjectId) {
    const ended = await this.ended(userId, this.since(ASK_WITHIN_DAYS));
    if (!ended.length) return [];
    const done = await this.ratings.find({ userId, subjectId: { $in: ended.map((r) => r.id) } }).toArray();
    const settled = new Set(done.filter((d) => d.stars !== null || d.declined || d.prompts >= MAX_PROMPTS).map((d) => `${d.subject}:${d.subjectId.toHexString()}`));
    return ended.filter((r) => !settled.has(`${r.subject}:${r.id.toHexString()}`));
  }

  /** A service's rating card: whether it can be rated, and the student's rating if any. */
  async mine(userId: ObjectId, subject: RatingSubject, id: ObjectId) {
    const [rateable] = await this.ended(userId, this.since(RATE_WITHIN_DAYS), { subject, id });
    const doc = await this.ratings.findOne({ userId, subject, subjectId: id });
    return { rateable: rateable ?? null, stars: doc?.stars ?? null, comment: doc?.comment ?? '' };
  }

  private async rateable(userId: ObjectId, subject: RatingSubject, id: ObjectId) {
    const [r] = await this.ended(userId, this.since(RATE_WITHIN_DAYS), { subject, id });
    if (!r) throw errors.notFound('Rien à noter ici (pas encore terminé, ou trop ancien).');
    return r;
  }

  private async upsert(userId: ObjectId, r: Rateable, set: Partial<RatingDoc>, inc?: Partial<Record<'prompts', number>>) {
    const now = this.clock.now();
    const base = { userId, subject: r.subject, subjectId: r.id };
    const insert: Partial<RatingDoc> = { _id: new ObjectId(), orgId: r.orgId, businessId: r.businessId, stars: null, comment: '', prompts: 0, declined: false, createdAt: now };
    for (const k of [...Object.keys(set), ...Object.keys(inc ?? {})]) delete insert[k as keyof RatingDoc];
    const update = { $set: { ...set, updatedAt: now }, $setOnInsert: insert, ...(inc ? { $inc: inc } : {}) };
    try {
      return (await this.ratings.findOneAndUpdate(base, update, { upsert: true, returnDocument: 'after' }))!;
    } catch (err) {
      // Two taps at once: the second one updates.
      if (!isDuplicateKey(err)) throw err;
      return (await this.ratings.findOneAndUpdate(base, update, { returnDocument: 'after' }))!;
    }
  }

  /** 1 to 5 stars and an optional word; changing it later replaces it (the word only if one is sent). The averages follow. */
  async rate(userId: ObjectId, subject: RatingSubject, id: ObjectId, stars: number, comment?: string) {
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw errors.validation('De 1 à 5 étoiles.', { field: 'stars' });
    const r = await this.rateable(userId, subject, id);
    // Without a comment: the earlier one stays (changing the stars only).
    const doc = await this.upsert(userId, r, { stars, declined: false, ...(comment !== undefined ? { comment: comment.trim() } : {}) });
    await this.refresh(r);
    return doc;
  }

  /** "Plus tard": asked again next time, a few times at most. */
  async later(userId: ObjectId, subject: RatingSubject, id: ObjectId) {
    await this.upsert(userId, await this.rateable(userId, subject, id), {}, { prompts: 1 });
  }

  /** "Ne pas noter": never asked again (the page still lets them rate). */
  async decline(userId: ObjectId, subject: RatingSubject, id: ObjectId) {
    await this.upsert(userId, await this.rateable(userId, subject, id), { declined: true });
  }

  /** The averages on the cards: the organizer's (its trips and events), the business's (its orders). */
  private async refresh(r: Rateable) {
    const avg = async (match: object) => {
      const [g] = await this.ratings.aggregate<{ avg: number; n: number }>([{ $match: { ...match, stars: { $ne: null } } }, { $group: { _id: null, avg: { $avg: '$stars' }, n: { $sum: 1 } } }]).toArray();
      return g ? { avg: Math.round(g.avg * 10) / 10, n: g.n } : { avg: null, n: 0 };
    };
    if (r.businessId) {
      const b = await avg({ businessId: r.businessId });
      await this.targets.setBusinessRating(r.businessId, b.avg, b.n);
    } else {
      const o = await avg({ orgId: r.orgId, subject: { $in: ['caravan', 'event'] } });
      await this.targets.setOrgRating(r.orgId, o.avg, o.n);
    }
  }

  // ---- What students read on a business's page ------------------------------------------------------------------

  /**
   * A restaurant's or shop's reviews: the average, how many of each star, and the latest comments (anonymous: stars,
   * words, when; never who).
   */
  async reviews(businessId: ObjectId, limit = REVIEWS_SHOWN) {
    const rated = { businessId, stars: { $ne: null } };
    const groups = await this.ratings.aggregate<{ _id: number; n: number }>([{ $match: rated }, { $group: { _id: '$stars', n: { $sum: 1 } } }]).toArray();
    const distribution = [1, 2, 3, 4, 5].map((stars) => ({ stars, count: groups.find((g) => g._id === stars)?.n ?? 0 }));
    const count = distribution.reduce((n, d) => n + d.count, 0);
    const avg = count ? Math.round((distribution.reduce((s, d) => s + d.stars * d.count, 0) / count) * 10) / 10 : null;
    const items = await this.ratings.find({ ...rated, comment: { $ne: '' } }).sort({ updatedAt: -1 }).limit(limit).toArray();
    return { avg, count, distribution: distribution.reverse(), comments: await this.ratings.countDocuments({ ...rated, comment: { $ne: '' } }), items: items.map((r) => ({ stars: r.stars!, comment: r.comment, at: r.updatedAt.toISOString() })) };
  }

  // ---- Worker: ask as soon as it's over ---------------------------------------------------------------------------

  /**
   * Trips and events that just ended: their travellers / attendees get one notification inviting them to rate. (An
   * order's own "remise" notification already leads to its page, which asks.)
   */
  async sweep() {
    const since = new Date(this.clock.now().getTime() - PUSH_WITHIN);
    let asked = 0;
    const ended = [
      ...(await this.db.collection('departures').find({ status: 'completed', completedAt: { $gte: since } }, { projection: { from: 1, to: 1, orgId: 1 } }).toArray()).map((d) => ({ subject: 'caravan' as const, id: d._id, kind: 'caravan_seat', what: `ton trajet ${d.from} → ${d.to}`, orgId: d.orgId as ObjectId })),
      ...(await this.db.collection('events').find({ status: 'completed', completedAt: { $gte: since } }, { projection: { title: 1, orgId: 1 } }).toArray()).map((e) => ({ subject: 'event' as const, id: e._id, kind: 'event_entry', what: `« ${e.title} »`, orgId: e.orgId as ObjectId })),
    ];
    for (const s of ended) {
      try {
        await this.db.collection('ratingAsks').insertOne({ subject: s.subject, subjectId: s.id, at: this.clock.now() });
      } catch (err) {
        if (isDuplicateKey(err)) continue;
        throw err;
      }
      const holders = await this.db.collection('tickets').distinct('holderUserId', { kind: s.kind, eventId: s.id, status: 'active', holderTravels: true });
      if (!holders.length) continue;
      const org = (await this.names('organizations', [s.orgId])).get(s.orgId.toHexString());
      await this.notifications.notify(holders as ObjectId[], {
        type: 'rating.ask', category: 'campus', icon: 'star-outline', tone: 'primary', url: `/noter/${s.subject}/${s.id.toHexString()}`, dedupeKey: `rating:${s.subject}:${s.id.toHexString()}`,
        title: s.subject === 'caravan' ? 'Bien arrivé ?' : 'C’était bien ?',
        body: `Comment s’est passé ${s.what}${org ? ` avec ${org}` : ''} ? Donne une note en un geste (facultatif).`,
      });
      asked++;
    }
    return asked;
  }
}
