import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import { randomCode } from '../../platform/security/crypto.js';
import type { Limiter } from '../../platform/security/limiter.js';
import { CAMPUS_LABELS, type AccountsApi, type Campus } from '../accounts/index.js';
import type { MediaApi } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import type { PaymentMethod, PaymentsApi, PurposeHandler } from '../payments/index.js';
import {
  ORDER_AUTO_COMPLETE_H,
  ORDER_PAY_WITHIN_MIN,
  type BusinessDoc,
  type BusinessKind,
  type CatalogItemDoc,
  type ItemSection,
  type OrderDoc,
  type OrderLine,
  type OrderMode,
  type OrderStatus,
  type Service,
} from './commerce.types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const fcfa = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
const localPhone = (e164: string) => e164.replace(/^\+221/, '').replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
/** "13:00" → "13h", "19:30" → "19h30". */
const hourLabel = (hhmm: string) => hhmm.replace(/^0/, '').replace(':00', 'h').replace(':', 'h');
/** Where to see a new order (business space) and to follow mine (student). */
const BUSINESS_ORDER_URL = (id: ObjectId) => `/commande-recue/${id.toHexString()}`;
const MY_ORDER_URL = (id: ObjectId) => `/commande/${id.toHexString()}`;
/** Steps the business moves an order through, and from where. */
const NEXT: Partial<Record<OrderStatus, OrderStatus>> = { placed: 'accepted', accepted: 'ready', ready: 'completed' };

export type BusinessInput = {
  name?: string;
  specialty?: string;
  description?: string;
  photoId?: string | null;
  location?: { lat: number; lng: number } | null;
  address?: string;
  campus?: Campus | null;
  phone?: string;
  services?: Service[];
  deliveryFee?: number | null;
  acceptingOrders?: boolean;
};

export type ItemInput = { section: ItemSection; category?: string | null; name: string; detail?: string; price: number; photoId?: string | null; stock?: number | null; available?: boolean; sortOrder?: number };

export class CommerceService {
  private readonly businesses: Collection<BusinessDoc>;
  private readonly items: Collection<CatalogItemDoc>;
  private readonly orders: Collection<OrderDoc>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly organizations: OrganizationsApi,
    private readonly payments: PaymentsApi,
    private readonly media: MediaApi,
    private readonly notifications: NotificationsApi,
    private readonly limiter: Limiter,
  ) {
    this.businesses = db.collection('businesses');
    this.items = db.collection('catalogItems');
    this.orders = db.collection('commerceOrders');
  }

  // ---- Admins: creating a restaurant or a shop --------------------------------------------------------------------

  /**
   * The organization (capability restaurant or shop, its payouts to the owner's number), its owner (an account is
   * created for a new number: they set their password with "mot de passe oublié") and its business profile.
   */
  async create(input: { kind: BusinessKind; name: string; specialty: string; owner: { phone: string; firstName: string; lastName: string } } & BusinessInput) {
    const phone = this.accounts.phoneOrThrow(input.owner.phone);
    const owner = (await this.accounts.findByPhone(phone)) ?? (await this.accounts.createStaffUser({ phone, firstName: input.owner.firstName, lastName: input.owner.lastName }));
    const slug = `${input.kind}-${input.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}-${randomCode(4).toLowerCase()}`;
    const org = await this.organizations.create({
      slug, name: input.name, category: input.kind === 'restaurant' ? 'Restaurant' : 'Boutique', capabilities: [input.kind], level: 'verifie', payoutPhone: owner.payoutAccount.phone,
    });
    await this.organizations.setMember(org._id, { phone, roles: ['owner'] }, null);
    const now = this.clock.now();
    const doc: BusinessDoc = {
      _id: new ObjectId(), orgId: org._id, kind: input.kind, name: input.name.trim(), specialty: input.specialty.trim(), description: '', photo: null, location: null, address: '', campus: null,
      phone: localPhone(owner.phone), services: input.kind === 'restaurant' ? [{ start: '12:00', end: '15:00' }, { start: '19:00', end: '22:00' }] : [{ start: '08:00', end: '21:00' }],
      deliveryFee: null, acceptingOrders: true, active: true, createdAt: now, updatedAt: now,
    };
    await this.businesses.insertOne(doc);
    return this.update(org._id, owner._id, input);
  }

  listAll() {
    return this.businesses.find({}).sort({ kind: 1, name: 1 }).toArray();
  }

  async setActive(id: ObjectId, active: boolean) {
    const b = await this.businesses.findOneAndUpdate({ _id: id }, { $set: { active, updatedAt: this.clock.now() } }, { returnDocument: 'after' });
    if (!b) throw errors.notFound('Commerce introuvable.');
    return b;
  }

  // ---- Its own space: profile and catalog -------------------------------------------------------------------------

  async ofOrg(orgId: ObjectId) {
    const b = await this.businesses.findOne({ orgId });
    if (!b) throw errors.notFound('Commerce introuvable.');
    return b;
  }

  async update(orgId: ObjectId, by: ObjectId, input: BusinessInput) {
    const b = await this.ofOrg(orgId);
    const set: Partial<BusinessDoc> = { updatedAt: this.clock.now() };
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.specialty !== undefined) set.specialty = input.specialty.trim();
    if (input.description !== undefined) set.description = input.description.trim();
    if (input.photoId !== undefined) set.photo = input.photoId ? (await this.media.claim(by, [input.photoId]))[0]! : null;
    if (input.location !== undefined) set.location = input.location;
    if (input.address !== undefined) set.address = input.address.trim();
    if (input.campus !== undefined) set.campus = input.campus;
    if (input.phone !== undefined) set.phone = localPhone(this.accounts.phoneOrThrow(input.phone));
    if (input.services !== undefined) {
      const ok = input.services.every((s) => /^\d{2}:\d{2}$/.test(s.start) && /^\d{2}:\d{2}$/.test(s.end) && minutes(s.start) < minutes(s.end) && minutes(s.end) <= 24 * 60);
      if (!ok || !input.services.length) throw errors.validation('Horaires invalides : de 08:00 à 15:00 par exemple.', { field: 'services' });
      set.services = [...input.services].sort((a, b2) => minutes(a.start) - minutes(b2.start));
    }
    if (input.deliveryFee !== undefined) set.deliveryFee = input.deliveryFee;
    if (input.acceptingOrders !== undefined) set.acceptingOrders = input.acceptingOrders;
    await this.businesses.updateOne({ _id: b._id }, { $set: set });
    return (await this.businesses.findOne({ _id: b._id }))!;
  }

  /** Everything in the catalog, unavailable items included (the business's view). */
  catalog(businessId: ObjectId) {
    return this.items.find({ businessId, archivedAt: null }).sort({ section: 1, sortOrder: 1, createdAt: 1 }).toArray();
  }

  private checkSection(b: BusinessDoc, section: ItemSection) {
    const allowed: ItemSection[] = b.kind === 'restaurant' ? ['menu', 'drink'] : ['article'];
    if (!allowed.includes(section)) throw errors.validation(b.kind === 'restaurant' ? 'Un restaurant propose des menus et des boissons.' : 'Une boutique propose des articles.', { field: 'section' });
  }

  async addItem(orgId: ObjectId, by: ObjectId, input: ItemInput) {
    const b = await this.ofOrg(orgId);
    this.checkSection(b, input.section);
    const now = this.clock.now();
    const doc: CatalogItemDoc = {
      _id: new ObjectId(), businessId: b._id, section: input.section, category: input.category?.trim() || null, name: input.name.trim(), detail: input.detail?.trim() ?? '', price: input.price,
      photo: input.photoId ? (await this.media.claim(by, [input.photoId]))[0]! : null, stock: b.kind === 'shop' ? (input.stock ?? null) : null, available: input.available ?? true,
      sortOrder: input.sortOrder ?? now.getTime(), archivedAt: null, createdAt: now, updatedAt: now,
    };
    await this.items.insertOne(doc);
    return doc;
  }

  async updateItem(orgId: ObjectId, by: ObjectId, itemId: ObjectId, input: Partial<ItemInput>) {
    const b = await this.ofOrg(orgId);
    const item = await this.items.findOne({ _id: itemId, businessId: b._id, archivedAt: null });
    if (!item) throw errors.notFound('Article introuvable.');
    if (input.section) this.checkSection(b, input.section);
    const set: Partial<CatalogItemDoc> = { updatedAt: this.clock.now() };
    if (input.section !== undefined) set.section = input.section;
    if (input.category !== undefined) set.category = input.category?.trim() || null;
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.detail !== undefined) set.detail = input.detail.trim();
    if (input.price !== undefined) set.price = input.price;
    if (input.photoId !== undefined) set.photo = input.photoId ? (await this.media.claim(by, [input.photoId]))[0]! : null;
    if (input.stock !== undefined && b.kind === 'shop') set.stock = input.stock;
    if (input.available !== undefined) set.available = input.available;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    await this.items.updateOne({ _id: itemId }, { $set: set });
    return (await this.items.findOne({ _id: itemId }))!;
  }

  /** Out of the catalog; past orders keep their lines. */
  async removeItem(orgId: ObjectId, itemId: ObjectId) {
    const b = await this.ofOrg(orgId);
    const res = await this.items.updateOne({ _id: itemId, businessId: b._id, archivedAt: null }, { $set: { archivedAt: this.clock.now() } });
    if (!res.matchedCount) throw errors.notFound('Article introuvable.');
  }

  // ---- Students: browsing ---------------------------------------------------------------------------------------------

  /** Open now: Dakar time is UTC, every day the same services. */
  status(b: Pick<BusinessDoc, 'services' | 'acceptingOrders'>) {
    const now = this.clock.now();
    const m = now.getUTCHours() * 60 + now.getUTCMinutes();
    const current = b.services.find((s) => m >= minutes(s.start) && m < minutes(s.end));
    const next = b.services.find((s) => m < minutes(s.start)) ?? b.services[0];
    const open = !!current && b.acceptingOrders;
    const label = !b.acceptingOrders
      ? 'Commandes en pause'
      : current
        ? `Ouvert · jusqu’à ${hourLabel(current.end)}`
        : next
          ? `Fermé · ${m < minutes(next.start) ? 'ouvre' : 'demain'} à ${hourLabel(next.start)}`
          : 'Fermé';
    return { open, label };
  }

  async list(kind: BusinessKind) {
    const docs = await this.businesses.find({ kind, active: true }).sort({ name: 1 }).toArray();
    const items = docs.length ? await this.items.find({ businessId: { $in: docs.map((d) => d._id) }, archivedAt: null, available: true }).sort({ sortOrder: 1 }).toArray() : [];
    return docs
      .map((b) => {
        const mine = items.filter((i) => i.businessId.equals(b._id));
        return {
          ...this.publicView(b),
          highlights: mine.filter((i) => i.section !== 'drink').slice(0, 3).map((i) => this.itemView(i)),
          minPrice: mine.length ? Math.min(...mine.map((i) => i.price)) : null,
          itemsCount: mine.length,
          // Searching "mafé" finds the restaurants that serve it.
          itemNames: mine.map((i) => i.name),
        };
      })
      .sort((a, b) => Number(b.open) - Number(a.open));
  }

  /**
   * The market: every available article of every open-or-not shop at once (one campus, a few hundred articles), each
   * with its shop, to browse and search across shops.
   */
  async market(kind: BusinessKind) {
    const docs = await this.businesses.find({ kind, active: true }).sort({ name: 1 }).toArray();
    const items = docs.length ? await this.items.find({ businessId: { $in: docs.map((d) => d._id) }, archivedAt: null, available: true }).sort({ sortOrder: 1 }).limit(1000).toArray() : [];
    return {
      businesses: docs.map((b) => this.publicView(b)).sort((a, b) => Number(b.open) - Number(a.open)),
      items: items.map((i) => ({ ...this.itemView(i), businessId: i.businessId.toHexString() })),
    };
  }

  async detail(id: ObjectId) {
    const b = await this.businesses.findOne({ _id: id, active: true });
    if (!b) throw errors.notFound('Commerce introuvable.');
    const items = await this.items.find({ businessId: b._id, archivedAt: null, available: true }).sort({ section: 1, sortOrder: 1 }).toArray();
    return { ...this.publicView(b), items: items.map((i) => this.itemView(i)) };
  }

  publicView(b: BusinessDoc) {
    const st = this.status(b);
    return {
      id: b._id.toHexString(),
      orgId: b.orgId.toHexString(),
      kind: b.kind,
      name: b.name,
      specialty: b.specialty,
      description: b.description,
      photo: b.photo?.url ?? null,
      location: b.location,
      address: b.address,
      campus: b.campus,
      campusLabel: b.campus ? CAMPUS_LABELS[b.campus] : null,
      phone: b.phone,
      services: b.services,
      hours: b.services.map((s) => `${hourLabel(s.start)}-${hourLabel(s.end)}`).join(' · '),
      open: st.open,
      statusLabel: st.label,
      deliveryFee: b.deliveryFee,
      acceptingOrders: b.acceptingOrders,
      active: b.active,
    };
  }

  itemView(i: CatalogItemDoc) {
    return {
      id: i._id.toHexString(), section: i.section, category: i.category, name: i.name, detail: i.detail, price: i.price, photo: i.photo?.url ?? null,
      stock: i.stock, soldOut: i.stock !== null && i.stock <= 0, available: i.available,
      photoId: i.photo?.mediaId.toHexString() ?? null,
    };
  }

  // ---- Students: ordering -----------------------------------------------------------------------------------------

  /**
   * One order to one business, paid now (Wave / Orange Money). Shops' stock is taken here (a conditional update per
   * article: two students never get the last one) and given back if the order isn't paid, is refused or cancelled.
   */
  async place(userId: ObjectId, businessId: ObjectId, input: { lines: { itemId: string; qty: number }[]; mode: OrderMode; address?: string | null; note?: string | null; method: PaymentMethod; returnUrl?: string | null }, baseUrl: string) {
    await this.limiter.hit(`order:${userId.toHexString()}`, { limit: 20, windowS: 3600 });
    this.payments.assertAvailable(input.method);
    const returnUrl = this.payments.validateReturnUrl(input.returnUrl);
    const b = await this.businesses.findOne({ _id: businessId, active: true });
    if (!b) throw errors.notFound('Commerce introuvable.');
    const st = this.status(b);
    if (!st.open) throw errors.conflict('BUSINESS_CLOSED', `${b.name} ne prend pas de commande pour le moment (${st.label.toLowerCase()}).`);
    if (input.mode === 'delivery' && b.deliveryFee === null) throw errors.validation(`${b.name} ne livre pas : choisis « À emporter ».`, { field: 'mode' });
    if (input.mode === 'delivery' && !input.address?.trim()) throw errors.validation('Indique où te livrer.', { field: 'address' });
    const wanted = input.lines.filter((l) => l.qty > 0);
    if (!wanted.length) throw errors.validation('Ton panier est vide.', { field: 'lines' });
    if (new Set(wanted.map((l) => l.itemId)).size !== wanted.length) throw errors.validation('Un article est en double.', { field: 'lines' });
    const items = await this.items.find({ _id: { $in: wanted.map((l) => (ObjectId.isValid(l.itemId) ? new ObjectId(l.itemId) : new ObjectId())) }, businessId: b._id, archivedAt: null }).toArray();
    const lines: OrderLine[] = wanted.map((l) => {
      const item = items.find((i) => i._id.toHexString() === l.itemId);
      if (!item || !item.available) throw errors.conflict('ITEM_UNAVAILABLE', `${item?.name ?? 'Un article'} n’est plus disponible : retire-le de ton panier.`);
      return { itemId: item._id, name: item.name, price: item.price, qty: l.qty };
    });
    const subtotal = lines.reduce((n, l) => n + l.price * l.qty, 0);
    const deliveryFee = input.mode === 'delivery' ? (b.deliveryFee ?? 0) : 0;
    const now = this.clock.now();

    const { order, payment } = await withTransaction(this.mongo, async (session) => {
      for (const l of lines) {
        const item = items.find((i) => i._id.equals(l.itemId))!;
        if (item.stock === null) continue;
        const taken = await this.items.updateOne({ _id: item._id, stock: { $gte: l.qty } }, { $inc: { stock: -l.qty }, $set: { updatedAt: now } }, { session });
        if (!taken.modifiedCount) throw errors.conflict('OUT_OF_STOCK', `Plus assez de « ${item.name} » : ${Math.max(0, item.stock)} restant${item.stock > 1 ? 's' : ''}.`);
      }
      const orderId = new ObjectId();
      const created = await this.payments.create(
        {
          userId, purpose: 'commerce_order', purposeRef: orderId, amount: subtotal + deliveryFee, method: input.method,
          description: `${b.name} · ${lines.reduce((n, l) => n + l.qty, 0)} article(s)`, expiresAt: new Date(now.getTime() + ORDER_PAY_WITHIN_MIN * MIN), returnUrl,
        },
        session,
      );
      const doc: OrderDoc = {
        _id: orderId, code: `C${randomCode(6)}`, businessId: b._id, orgId: b.orgId, userId, lines, subtotal, deliveryFee, total: subtotal + deliveryFee, mode: input.mode,
        address: input.mode === 'delivery' ? input.address!.trim() : null, note: input.note?.trim() || null, method: input.method, paymentId: created._id, status: 'pending_payment',
        history: [{ status: 'pending_payment', at: now, by: userId }], refusal: null, payoutId: null, refundPayoutId: null, createdAt: now, updatedAt: now,
      };
      await this.orders.insertOne(doc, { session });
      return { order: doc, payment: created };
    });
    return { order, payment: await this.payments.openCheckout(payment, baseUrl) };
  }

  readonly orderPayment: PurposeHandler = {
    onSucceeded: async (payment, session) => {
      const now = this.clock.now();
      const o = await this.orders.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'pending_payment', paymentId: payment._id },
        { $set: { status: 'placed', updatedAt: now }, $push: { history: { status: 'placed', at: now, by: null } } },
        { session, returnDocument: 'after' },
      );
      if (!o) {
        const cur = await this.orders.findOne({ _id: payment.purposeRef }, { session });
        return cur && cur.paymentId?.equals(payment._id) && cur.status !== 'expired' && cur.status !== 'cancelled' ? 'fulfilled' : 'unfulfillable';
      }
      afterCommit(session, () => this.tellBusiness(o));
      return 'fulfilled';
    },
    onClosed: async (payment, session) => {
      const o = await this.orders.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'pending_payment', paymentId: payment._id },
        { $set: { status: 'expired', updatedAt: this.clock.now() }, $push: { history: { status: 'expired', at: this.clock.now(), by: null } } },
        { session, returnDocument: 'after' },
      );
      if (o) await this.giveBackStock(o, session);
    },
  };

  private async giveBackStock(o: OrderDoc, session: ClientSession) {
    for (const l of o.lines) await this.items.updateOne({ _id: l.itemId, stock: { $ne: null } }, { $inc: { stock: l.qty } }, { session });
  }

  /** A new order: every member of the team (owner, managers, staff) gets the push, with the sound. */
  private async tellBusiness(o: OrderDoc) {
    const team = (await this.organizations.members(o.orgId)).filter((m) => m.roles.some((r) => r === 'owner' || r === 'manager' || r === 'staff'));
    const what = o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ');
    await this.notifications.notify(
      team.map((m) => m.userId),
      {
        type: 'commerce.order_placed', category: 'paiements', icon: 'receipt-outline', tone: 'success', url: BUSINESS_ORDER_URL(o._id), dedupeKey: `order:${o._id.toHexString()}:placed`, channel: 'orders',
        title: `Nouvelle commande ${o.code} · ${fcfa(o.total)}`,
        body: `${what}. ${o.mode === 'delivery' ? `Livraison : ${o.address}` : 'À emporter'}.`,
      },
    );
  }

  private async tellStudent(o: OrderDoc, b: Pick<BusinessDoc, 'name'>) {
    const msg: Partial<Record<OrderStatus, { title: string; body: string; tone: 'success' | 'primary' | 'danger' }>> = {
      accepted: { title: `${b.name} prépare ta commande`, body: `Commande ${o.code} acceptée.`, tone: 'primary' },
      ready:
        o.mode === 'delivery'
          ? { title: `Ta commande arrive`, body: `${b.name} : ta commande ${o.code} est en route.`, tone: 'success' }
          : { title: `Ta commande est prête`, body: `Passe la chercher chez ${b.name} avec le code ${o.code}.`, tone: 'success' },
      completed:
        o.mode === 'delivery'
          ? { title: 'Commande livrée', body: `${b.name} : ta commande ${o.code} t’a été livrée. Bon appétit !`, tone: 'success' }
          : { title: 'Commande récupérée', body: `${b.name} : ta commande ${o.code} t’a été remise.`, tone: 'success' },
      refused: { title: `Commande refusée · ${b.name}`, body: `${o.refusal ?? 'Le commerce ne peut pas la servir.'} Tu es remboursé (${fcfa(o.total)}).`, tone: 'danger' },
    };
    const m = msg[o.status];
    if (!m) return;
    await this.notifications.notify([o.userId], {
      type: `commerce.order_${o.status}`, category: 'paiements', icon: o.status === 'refused' ? 'close-circle-outline' : 'bag-check-outline', tone: m.tone,
      url: MY_ORDER_URL(o._id), dedupeKey: `order:${o._id.toHexString()}:${o.status}`, title: m.title, body: m.body,
    });
  }

  /** Before the business accepts it: refunded in full. The team hears it (no need to prepare it any more). */
  async cancel(userId: ObjectId, orderId: ObjectId) {
    const o = await this.closeWithRefund({ _id: orderId, userId }, 'cancelled', userId, null);
    const team = (await this.organizations.members(o.orgId)).filter((m) => m.roles.some((r) => r === 'owner' || r === 'manager' || r === 'staff'));
    await this.notifications.notify(
      team.map((m) => m.userId),
      {
        type: 'commerce.order_cancelled', category: 'paiements', icon: 'close-circle-outline', tone: 'danger', url: BUSINESS_ORDER_URL(o._id), dedupeKey: `order:${o._id.toHexString()}:cancelled`,
        title: `Commande ${o.code} annulée`, body: 'Le client a annulé avant que tu l’acceptes. Il est remboursé : rien à préparer.',
      },
    );
    return o;
  }

  private async closeWithRefund(filter: { _id: ObjectId; userId?: ObjectId; orgId?: ObjectId }, to: 'cancelled' | 'refused', by: ObjectId, reason: string | null) {
    const payoutIds: ObjectId[] = [];
    let order!: OrderDoc;
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const o = await this.orders.findOneAndUpdate(
        { ...filter, status: 'placed' },
        { $set: { status: to, refusal: reason, updatedAt: now }, $push: { history: { status: to, at: now, by } } },
        { session, returnDocument: 'after' },
      );
      if (!o) {
        const cur = await this.orders.findOne(filter, { session });
        if (!cur) throw errors.notFound('Commande introuvable.');
        throw errors.conflict('ORDER_ALREADY_TAKEN', to === 'cancelled' ? 'Le commerce a déjà pris ta commande en charge : contacte-le.' : 'Cette commande n’attend plus de réponse.');
      }
      await this.giveBackStock(o, session);
      const payout = await this.payments.createPayout(
        { kind: 'refund', beneficiaryUserId: o.userId, method: o.method, amount: o.total, reason: to === 'refused' ? 'order_refused' : 'order_cancelled', source: { type: 'order', id: o._id }, idempotencyKey: `order:${o._id.toHexString()}:refund` },
        session,
      );
      payoutIds.push(payout._id);
      await this.orders.updateOne({ _id: o._id }, { $set: { refundPayoutId: payout._id } }, { session });
      order = { ...o, refundPayoutId: payout._id };
    });
    await this.payments.schedulePayouts(payoutIds);
    return order;
  }

  async mine(userId: ObjectId) {
    const docs = await this.orders.find({ userId, status: { $ne: 'expired' } }).sort({ createdAt: -1 }).limit(50).toArray();
    return this.orderViews(docs, false);
  }

  async mineOne(userId: ObjectId, id: ObjectId) {
    const o = await this.orders.findOne({ _id: id, userId });
    if (!o) throw errors.notFound('Commande introuvable.');
    return (await this.orderViews([o], false))[0]!;
  }

  // ---- The business: incoming orders ------------------------------------------------------------------------------

  /** Active orders first (to serve), then the day's finished ones. */
  async queue(orgId: ObjectId, scope: 'active' | 'done') {
    const b = await this.ofOrg(orgId);
    const since = new Date(this.clock.now().getTime() - 48 * HOUR);
    const docs = await this.orders
      .find(scope === 'active' ? { businessId: b._id, status: { $in: ['placed', 'accepted', 'ready'] } } : { businessId: b._id, status: { $in: ['completed', 'refused', 'cancelled'] }, updatedAt: { $gt: since } })
      .sort({ createdAt: scope === 'active' ? 1 : -1 })
      .limit(200)
      .toArray();
    return this.orderViews(docs, true);
  }

  async businessOrder(orgId: ObjectId, id: ObjectId) {
    const o = await this.orders.findOne({ _id: id, orgId, status: { $ne: 'pending_payment' } });
    if (!o) throw errors.notFound('Commande introuvable.');
    return (await this.orderViews([o], true))[0]!;
  }

  /** accepted → ready → completed, one step at a time. Completed: the amount goes to the business's number. */
  async advance(orgId: ObjectId, id: ObjectId, by: ObjectId, to: 'accepted' | 'ready' | 'completed') {
    const from = (Object.keys(NEXT) as OrderStatus[]).find((k) => NEXT[k] === to)!;
    const now = this.clock.now();
    const o = await this.orders.findOneAndUpdate(
      { _id: id, orgId, status: from },
      { $set: { status: to, updatedAt: now }, $push: { history: { status: to, at: now, by } } },
      { returnDocument: 'after' },
    );
    if (!o) {
      if (!(await this.orders.findOne({ _id: id, orgId }))) throw errors.notFound('Commande introuvable.');
      throw errors.conflict('ORDER_STEP', 'Cette commande a déjà changé : recharge la liste.');
    }
    const b = await this.businesses.findOne({ _id: o.businessId });
    if (to === 'completed') await this.payOut(o, by);
    await this.tellStudent(o, b!);
    return o;
  }

  /**
   * At the counter: the student gives their order's code (typed, or its QR scanned, "UGBCMD:C7KQ2M"). An order being
   * prepared or ready is handed over (completed, paid out); anything else says why not.
   */
  async handover(orgId: ObjectId, rawCode: string, by: ObjectId) {
    const code = rawCode.trim().toUpperCase().replace(/^UGBCMD:/, '').replace(/\s/g, '');
    const o = await this.orders.findOne({ orgId, code, status: { $ne: 'pending_payment' } });
    if (!o) throw errors.notFound(`Aucune commande ${code} chez toi.`);
    if (o.status === 'completed') throw errors.conflict('ORDER_ALREADY_DONE', `La commande ${code} a déjà été remise.`);
    if (o.status === 'placed') throw errors.conflict('ORDER_NOT_ACCEPTED', `Accepte d’abord la commande ${code}.`);
    if (o.status !== 'accepted' && o.status !== 'ready') throw errors.conflict('ORDER_CLOSED', `La commande ${code} a été ${o.status === 'refused' ? 'refusée' : 'annulée'}.`);
    const now = this.clock.now();
    const done = await this.orders.findOneAndUpdate(
      { _id: o._id, status: o.status },
      { $set: { status: 'completed', updatedAt: now }, $push: { history: { status: 'completed', at: now, by } } },
      { returnDocument: 'after' },
    );
    if (!done) throw errors.conflict('ORDER_STEP', 'Cette commande a déjà changé : réessaie.');
    await this.payOut(done, by);
    const b = await this.businesses.findOne({ _id: done.businessId });
    await this.tellStudent(done, b!);
    return done;
  }

  async refuse(orgId: ObjectId, id: ObjectId, by: ObjectId, reason: string) {
    const o = await this.closeWithRefund({ _id: id, orgId }, 'refused', by, reason);
    const b = await this.businesses.findOne({ _id: o.businessId });
    await this.tellStudent(o, b!);
    return o;
  }

  /** The order's amount to the organization's payout number, once. */
  private async payOut(o: OrderDoc, by: ObjectId | null) {
    const phone = await this.organizations.payoutPhone(o.orgId);
    if (!phone) return;
    const owner = by ?? (await this.organizations.members(o.orgId)).find((m) => m.roles.includes('owner'))?.userId;
    if (!owner) return;
    const payoutIds: ObjectId[] = [];
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const payout = await this.payments.createPayout(
        { kind: 'organizer_claim', beneficiaryUserId: owner, payTo: { orgId: o.orgId, phone }, method: o.method, amount: o.total, reason: 'order_payout', source: { type: 'order', id: o._id }, idempotencyKey: `order:${o._id.toHexString()}:payout` },
        session,
      );
      payoutIds.push(payout._id);
      await this.orders.updateOne({ _id: o._id }, { $set: { payoutId: payout._id } }, { session });
    });
    await this.payments.schedulePayouts(payoutIds);
  }

  /** Worker: orders left accepted or ready for 12 h are completed (served), and paid out. */
  async sweep() {
    const old = await this.orders.find({ status: { $in: ['accepted', 'ready'] }, updatedAt: { $lt: new Date(this.clock.now().getTime() - ORDER_AUTO_COMPLETE_H * HOUR) } }).limit(100).toArray();
    for (const o of old) {
      const now = this.clock.now();
      const done = await this.orders.findOneAndUpdate({ _id: o._id, status: o.status }, { $set: { status: 'completed', updatedAt: now }, $push: { history: { status: 'completed', at: now, by: null } } }, { returnDocument: 'after' });
      if (done) await this.payOut(done, null);
    }
    return old.length;
  }

  private async orderViews(docs: OrderDoc[], forBusiness: boolean) {
    if (!docs.length) return [];
    const businesses = await this.businesses.find({ _id: { $in: [...new Map(docs.map((d) => [d.businessId.toHexString(), d.businessId])).values()] } }).toArray();
    const customers = forBusiness ? await this.accounts.contactsByIds([...new Map(docs.map((d) => [d.userId.toHexString(), d.userId])).values()]) : new Map();
    // Each line with its item's current picture (null once the item has none, or was deleted).
    const itemIds = [...new Map(docs.flatMap((d) => d.lines.map((l) => [l.itemId.toHexString(), l.itemId] as const))).values()];
    const photos = new Map((await this.items.find({ _id: { $in: itemIds } }, { projection: { photo: 1 } }).toArray()).map((i) => [i._id.toHexString(), i.photo?.url ?? null]));
    return Promise.all(
      docs.map(async (o) => {
        const b = businesses.find((x) => x._id.equals(o.businessId))!;
        const payment = !forBusiness && o.status === 'pending_payment' && o.paymentId ? await this.payments.findById(o.paymentId) : null;
        const c = customers.get(o.userId.toHexString());
        return {
          id: o._id.toHexString(),
          code: o.code,
          status: o.status,
          business: { id: b._id.toHexString(), kind: b.kind, name: b.name, phone: b.phone, photo: b.photo?.url ?? null, address: b.address },
          lines: o.lines.map((l) => ({ itemId: l.itemId.toHexString(), name: l.name, price: l.price, qty: l.qty, photo: photos.get(l.itemId.toHexString()) ?? null })),
          subtotal: o.subtotal,
          deliveryFee: o.deliveryFee,
          total: o.total,
          mode: o.mode,
          address: o.address,
          note: o.note,
          refusal: o.refusal,
          refunded: !!o.refundPayoutId,
          history: o.history.map((h) => ({ status: h.status, at: h.at.toISOString() })),
          createdAt: o.createdAt.toISOString(),
          payment: payment && (payment.status === 'created' || payment.status === 'pending') ? { reference: payment.reference, checkoutUrl: payment.checkoutUrl } : null,
          // The business calls or meets the student: their name and number.
          customer: forBusiness && c ? { name: `${c.firstName} ${c.lastName}`, phone: localPhone(c.phone) } : null,
        };
      }),
    );
  }
}
