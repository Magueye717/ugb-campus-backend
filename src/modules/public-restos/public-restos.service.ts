import { ObjectId, type Collection, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import { randomCode } from '../../platform/security/crypto.js';
import type { Campus } from '../accounts/index.js';
import type { AlertsApi } from '../alerts/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { MEAL_LABELS, MEALS, type Dish, type DishInput, type DishStatus, type Meal, type PublicMenuDoc, type PublicRestoDoc, type Service } from './public-restos.types.js';

const MIN = 60_000;
/** Where students see the menus: the "Restos publics" tab. */
const MENUS_ROUTE = '/(tabs)/resto?vue=publics';
const dakarDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dakar', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Local date "YYYY-MM-DD" in Dakar. */
export const localDate = (d: Date) => dakarDay.format(d);
/** "2026-11-02" + "15:00" → the instant. Dakar is UTC+0 all year (no daylight saving). */
const instant = (date: string, hm: string) => new Date(`${date}T${hm}:00.000Z`);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(instant(s, '00:00').getTime());

export const DEFAULT_SERVICES: Record<Meal, Service> = { lunch: { start: '12:00', end: '15:00' }, dinner: { start: '19:00', end: '21:00' } };

const dishView = (d: Dish) => ({ id: d.dishId, name: d.name, detail: d.detail, status: d.status, statusAt: d.statusAt.toISOString() });
export const menuView = (m: PublicMenuDoc) => ({ id: m._id.toHexString(), restoId: m.restoId.toHexString(), date: m.date, meal: m.meal, dishes: m.dishes.map(dishView), updatedAt: m.updatedAt.toISOString() });
export const restoView = (r: PublicRestoDoc) => ({ id: r._id.toHexString(), slug: r.slug, name: r.name, location: r.location, campus: r.campus, coords: r.point ?? null, sortOrder: r.sortOrder, services: r.services, status: r.status });

export type RestoInput = { slug: string; name: string; location?: string; campus?: Campus | null; coords?: { lat: number; lng: number } | null; sortOrder?: number; services?: Partial<Record<Meal, Service>> };

export class PublicRestosService {
  private readonly restos: Collection<PublicRestoDoc>;
  private readonly menus: Collection<PublicMenuDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly alerts: AlertsApi,
    private readonly notifications: NotificationsApi,
  ) {
    this.restos = db.collection('publicRestos');
    this.menus = db.collection('publicMenus');
  }

  // ---- Students ------------------------------------------------------------------------------------------------

  /** Every open restaurant with its lunch and dinner menus of the day (today in Dakar by default). */
  async day(date?: string) {
    const day = date ?? localDate(this.clock.now());
    if (!isDate(day)) throw errors.validation('Date invalide (AAAA-MM-JJ).', { field: 'date' });
    const restos = await this.restos.find({ status: 'active' }).sort({ sortOrder: 1, name: 1 }).toArray();
    const menus = await this.menus.find({ date: day, restoId: { $in: restos.map((r) => r._id) } }).toArray();
    return {
      date: day,
      restos: restos.map((r) => {
        const of = (meal: Meal) => menus.find((m) => m.restoId.equals(r._id) && m.meal === meal);
        const lunch = of('lunch');
        const dinner = of('dinner');
        return { ...restoView(r), menus: { lunch: lunch ? menuView(lunch) : null, dinner: dinner ? menuView(dinner) : null } };
      }),
    };
  }

  // ---- Catering staff: restaurants -----------------------------------------------------------------------------

  listRestos() {
    return this.restos.find({}).sort({ sortOrder: 1, name: 1 }).toArray();
  }

  async createResto(input: RestoInput) {
    const now = this.clock.now();
    const doc: PublicRestoDoc = {
      _id: new ObjectId(), slug: input.slug, name: input.name.trim(), location: input.location?.trim() ?? '', campus: input.campus ?? null, point: input.coords ?? null, sortOrder: input.sortOrder ?? 0,
      services: this.services(DEFAULT_SERVICES, input.services), status: 'active', createdAt: now, updatedAt: now,
    };
    try {
      await this.restos.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err, 'slug_unique')) throw errors.conflict('SLUG_TAKEN', 'Ce restaurant existe déjà.');
      throw err;
    }
    return doc;
  }

  async updateResto(id: ObjectId, input: Partial<Omit<RestoInput, 'slug'>> & { status?: PublicRestoDoc['status'] }) {
    const r = await this.resto(id, true);
    const set: Partial<PublicRestoDoc> = { updatedAt: this.clock.now() };
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.location !== undefined) set.location = input.location.trim();
    if (input.campus !== undefined) set.campus = input.campus;
    if (input.coords !== undefined) set.point = input.coords;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    if (input.services) set.services = this.services(r.services, input.services);
    if (input.status) set.status = input.status;
    return (await this.restos.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' }))!;
  }

  private services(base: Record<Meal, Service>, change?: Partial<Record<Meal, Service>>) {
    const out = { ...base, ...change };
    for (const meal of MEALS) {
      if (out[meal].end <= out[meal].start) throw errors.validation(`Horaires du ${MEAL_LABELS[meal]} : la fin doit être après le début.`, { field: `services.${meal}` });
    }
    return out;
  }

  private async resto(id: ObjectId, includeArchived = false) {
    const r = await this.restos.findOne({ _id: id, ...(includeArchived ? {} : { status: 'active' as const }) });
    if (!r) throw errors.notFound('Restaurant introuvable.');
    return r;
  }

  // ---- Catering staff: menus -----------------------------------------------------------------------------------

  /** A restaurant's menus between two dates (the week being planned). */
  async menusOf(restoId: ObjectId, from: string, to: string) {
    if (!isDate(from) || !isDate(to) || to < from) throw errors.validation('Période invalide.', { field: 'from' });
    if (instant(to, '00:00').getTime() - instant(from, '00:00').getTime() > 62 * 24 * 60 * MIN) throw errors.validation('Deux mois au plus.', { field: 'to' });
    await this.resto(restoId, true);
    return this.menus.find({ restoId, date: { $gte: from, $lte: to } }).sort({ date: 1, meal: 1 }).toArray();
  }

  /**
   * Publishes (or replaces) the menu of one meal. A dish sent with its `id` keeps its stock level unless a new one
   * is given; dishes left out disappear, and their "rupture" alerts with them.
   */
  async putMenu(restoId: ObjectId, date: string, meal: Meal, input: DishInput[], by: ObjectId) {
    if (!isDate(date)) throw errors.validation('Date invalide (AAAA-MM-JJ).', { field: 'date' });
    if (date < localDate(new Date(this.clock.now().getTime() - 24 * 60 * MIN))) throw errors.rule('MENU_IN_PAST', 'Ce jour est passé.');
    const resto = await this.resto(restoId);
    const names = input.map((d) => d.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) throw errors.validation('Le même plat est en double.', { field: 'dishes' });
    const before = await this.menus.findOne({ restoId, date, meal });
    const now = this.clock.now();
    const dishes: Dish[] = input.map((d) => {
      const old = d.id ? before?.dishes.find((x) => x.dishId === d.id) : undefined;
      const status = d.status ?? old?.status ?? 'available';
      return { dishId: old?.dishId ?? randomCode(8), name: d.name.trim(), detail: d.detail?.trim() ?? '', status, statusAt: old && old.status === status ? old.statusAt : now };
    });
    const menu = (await this.menus.findOneAndUpdate(
      { restoId, date, meal },
      { $set: { dishes, updatedBy: by, updatedAt: now }, $setOnInsert: { _id: new ObjectId(), createdBy: by, createdAt: now } },
      { upsert: true, returnDocument: 'after' },
    ))!;
    // Alerts follow the new menu: removed dishes and dishes back in stock leave the home screen, new ruptures appear.
    for (const old of before?.dishes ?? []) if (old.status === 'out' && !dishes.some((d) => d.dishId === old.dishId && d.status === 'out')) await this.alerts.clear(this.alertKey(menu, old.dishId));
    for (const d of dishes) if (d.status === 'out' && before?.dishes.find((x) => x.dishId === d.dishId)?.status !== 'out') await this.soldOut(resto, menu, d, false);
    return menu;
  }

  async deleteMenu(restoId: ObjectId, date: string, meal: Meal) {
    const menu = await this.menus.findOneAndDelete({ restoId, date, meal });
    if (!menu) throw errors.notFound('Pas de menu pour ce repas.');
    for (const d of menu.dishes) if (d.status === 'out') await this.alerts.clear(this.alertKey(menu, d.dishId));
  }

  /**
   * "Bientôt fini", "Rupture", or back in stock. A rupture puts an alert on the home screen until the end of the
   * service; with `notify`, everyone with the app is also told (once).
   */
  async setDishStatus(restoId: ObjectId, date: string, meal: Meal, dishId: string, status: DishStatus, by: ObjectId, notify = false) {
    const resto = await this.resto(restoId);
    const now = this.clock.now();
    const before = await this.menus.findOneAndUpdate(
      { restoId, date, meal, 'dishes.dishId': dishId },
      { $set: { 'dishes.$[d].status': status, 'dishes.$[d].statusAt': now, updatedBy: by, updatedAt: now } },
      { arrayFilters: [{ 'd.dishId': dishId }], returnDocument: 'before' },
    );
    if (!before) throw errors.notFound('Plat introuvable dans ce menu.');
    const was = before.dishes.find((d) => d.dishId === dishId)!;
    const menu: PublicMenuDoc = { ...before, dishes: before.dishes.map((d) => (d.dishId === dishId ? { ...d, status, statusAt: was.status === status ? d.statusAt : now } : d)), updatedAt: now };
    const dish = menu.dishes.find((d) => d.dishId === dishId)!;
    if (status === 'out' && was.status !== 'out') await this.soldOut(resto, menu, dish, notify);
    if (status !== 'out' && was.status === 'out') await this.alerts.clear(this.alertKey(menu, dishId));
    return menu;
  }

  private alertKey(menu: PublicMenuDoc, dishId: string) {
    return `public-menu:${menu._id.toHexString()}:${dishId}`;
  }

  /** "Rupture · Thiébou dieun · Resto 1": on the home screen until the end of the service; pushed if asked. */
  private async soldOut(resto: PublicRestoDoc, menu: PublicMenuDoc, dish: Dish, notify: boolean) {
    const now = this.clock.now();
    const service = resto.services[menu.meal];
    const end = instant(menu.date, service.end);
    // Only today's service, while it isn't over: a rupture planned for another day isn't news yet.
    if (menu.date !== localDate(now) || end <= now) return;
    const left = menu.dishes.filter((d) => d.status !== 'out').map((d) => d.name);
    const title = `Rupture · ${dish.name} · ${resto.name}`;
    // The restaurant's campus only (nobody crosses the campus for a dish), everyone if it has none.
    const audience = { campuses: resto.campus ? [resto.campus] : [], ufrs: [], regions: [] };
    const body = `Plus de ${dish.name} au ${resto.name} pour le ${MEAL_LABELS[menu.meal]}.${left.length ? ` Encore au menu : ${left.join(', ')}.` : ''}`;
    const fresh = await this.alerts.raise(this.alertKey(menu, dish.dishId), {
      kind: 'resto_stock', title, body, icon: 'restaurant-outline', tone: 'warning', href: MENUS_ROUTE, audience, startsAt: now, endsAt: end,
    });
    if (fresh && notify) await this.notifications.broadcast({ title, body, url: MENUS_ROUTE, category: 'campus', dedupeKey: `${this.alertKey(menu, dish.dishId)}:${now.getTime()}`, segment: audience });
  }
}
