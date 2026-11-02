import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, nextPhone, registerStudent, T0, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true' });
});
afterAll(async () => t.close());

type Who = { userId: string | ObjectId };
async function call(who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(String(who.userId)), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
const pay = (reference: string) => t.app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${reference}/pay`, headers: { 'content-type': 'text/plain' }, payload: '' });
const types = async (who: Who) => (await ok(call(who, 'GET', '/notifications'))).items.map((n: { type: string }) => n.type);

/** A business created by an admin, open all day (the test clock is 10:00 in Dakar). */
async function business(kind: 'restaurant' | 'shop', extra: object = {}) {
  t.clock.set(T0);
  const admin = await createStaff(t, ['admin']);
  const phone = nextPhone();
  const b = await ok(
    call(admin, 'POST', '/admin/businesses', {
      kind, name: kind === 'restaurant' ? 'Khoulé & Frère' : 'Papeterie du Campus', specialty: kind === 'restaurant' ? 'Sénégalais' : 'Fournitures',
      owner: { phone, firstName: 'Modou', lastName: 'Khoulé' }, address: 'Près du Village E', campus: 'campus1', location: { lat: 16.06, lng: -16.42 },
      services: [{ start: '08:00', end: '23:00' }], deliveryFee: 200, ...extra,
    }),
    201,
  );
  const owner = (await t.c.modules.accounts.findByPhone(`+221${phone}`))!;
  return { b, owner: { userId: owner._id }, orgId: b.orgId as string, admin };
}

describe('restaurants', () => {
  it('created by an admin; the owner gets a business space, adds staff and menus; staff only switch availability', async () => {
    const { b, owner, orgId } = await business('restaurant');
    expect(b).toMatchObject({ kind: 'restaurant', name: 'Khoulé & Frère', open: true, statusLabel: 'Ouvert · jusqu’à 23h', deliveryFee: 200, campusLabel: 'Campus 1', location: { lat: 16.06, lng: -16.42 } });
    expect((await ok(call(owner, 'GET', '/me'))).spaces).toContain('business');

    const staff = await createStaff(t);
    expect((await call(owner, 'PUT', `/org/${orgId}/members`, { phone: staff.phone, roles: ['staff'] })).statusCode).toBe(204);
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/catalog`, { section: 'menu', name: 'Mafé yap', detail: 'Riz · sauce arachide', price: 1500 }), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/catalog`, { section: 'drink', name: 'Bissap', price: 300 }), 201);
    expect((await call(owner, 'POST', `/org/${orgId}/catalog`, { section: 'article', name: 'Cahier', price: 300 })).statusCode).toBe(400);
    expect((await call(staff, 'POST', `/org/${orgId}/catalog`, { section: 'menu', name: 'Yassa', price: 1700 })).statusCode).toBe(404);
    expect((await call(staff, 'PATCH', `/org/${orgId}/catalog/${mafe.id}`, { price: 100 })).statusCode).toBe(403);
    expect((await ok(call(staff, 'PATCH', `/org/${orgId}/catalog/${mafe.id}`, { available: false }))).available).toBe(false);
    await ok(call(staff, 'PATCH', `/org/${orgId}/catalog/${mafe.id}`, { available: true }));

    const s = await registerStudent(t);
    const listed = (await ok(call(s, 'GET', '/businesses?kind=restaurant'))).items.find((x: { id: string }) => x.id === b.id);
    expect(listed).toMatchObject({ open: true, minPrice: 300, highlights: [expect.objectContaining({ name: 'Mafé yap' })] });
    expect((await ok(call(s, 'GET', `/businesses/${b.id}`))).items.map((i: { name: string }) => i.name)).toEqual(['Bissap', 'Mafé yap']);
  });

  it('an order: paid, the team notified; accepted, ready, completed (paid out); another refused (refunded)', async () => {
    const { b, owner, orgId } = await business('restaurant');
    const staff = await createStaff(t);
    await call(owner, 'PUT', `/org/${orgId}/members`, { phone: staff.phone, roles: ['staff'] });
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/catalog`, { section: 'menu', name: 'Mafé yap', price: 1500 }), 201);
    const bissap = await ok(call(owner, 'POST', `/org/${orgId}/catalog`, { section: 'drink', name: 'Bissap', price: 300 }), 201);
    const s = await registerStudent(t);

    expect(json(await call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'delivery', method: 'wave' })).field).toBe('address');
    const { order, payment } = await ok(
      call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 2 }, { itemId: bissap.id, qty: 1 }], mode: 'delivery', address: 'Village E, chambre 214', method: 'wave' }),
      201,
    );
    expect(order).toMatchObject({ status: 'pending_payment', subtotal: 3300, deliveryFee: 200, total: 3500, payment: { reference: payment.reference } });
    // Not paid yet: the business doesn't see it.
    expect((await ok(call(owner, 'GET', `/org/${orgId}/orders`))).items).toEqual([]);
    await pay(payment.reference);
    const queue = (await ok(call(staff, 'GET', `/org/${orgId}/orders`))).items;
    expect(queue[0]).toMatchObject({ id: order.id, status: 'placed', customer: { name: 'Awa Diop' }, address: 'Village E, chambre 214' });
    // Each line with its item's picture (none here).
    expect(queue[0].lines[0]).toEqual({ itemId: mafe.id, name: 'Mafé yap', price: 1500, qty: 2, photo: null });
    expect(await types(owner)).toContain('commerce.order_placed');
    expect(await types(staff)).toContain('commerce.order_placed');
    // The shop's space shows only its orders, not the owner's other notifications.
    await t.c.modules.notifications.notify([owner.userId], { type: 'ticket.transfer_offered', category: 'paiements', title: 'Billet', body: 'Pour toi', icon: 'ticket-outline', dedupeKey: `test:${order.id}` });
    expect((await ok(call(owner, 'GET', '/notifications?scope=orders'))).items.map((n: { type: string }) => n.type)).toEqual(['commerce.order_placed']);
    expect(await ok(call(owner, 'GET', '/notifications/unread-count?scope=orders'))).toEqual({ count: 1 });
    expect((await call(owner, 'POST', '/notifications/read', { all: true, scope: 'orders' })).statusCode).toBe(204);
    expect(await ok(call(owner, 'GET', '/notifications/unread-count?scope=orders'))).toEqual({ count: 0 });
    expect(await ok(call(owner, 'GET', '/notifications/unread-count'))).toEqual({ count: 1 });

    await ok(call(staff, 'POST', `/org/${orgId}/orders/${order.id}/accept`));
    expect(json(await call(s, 'POST', `/me/orders/${order.id}/cancel`)).code).toBe('ORDER_ALREADY_TAKEN');
    await ok(call(staff, 'POST', `/org/${orgId}/orders/${order.id}/ready`));
    expect(await types(s)).toEqual(expect.arrayContaining(['commerce.order_accepted', 'commerce.order_ready']));
    expect(json(await call(staff, 'POST', `/org/${orgId}/orders/${order.id}/ready`)).code).toBe('ORDER_STEP');
    await ok(call(staff, 'POST', `/org/${orgId}/orders/${order.id}/complete`));
    const done = await t.c.mongo.db.collection('commerceOrders').findOne({ _id: new ObjectId(order.id as string) });
    const payout = await t.c.mongo.db.collection('payouts').findOne({ _id: done!.payoutId });
    expect(payout).toMatchObject({ kind: 'organizer_claim', amount: 3500, reason: 'order_payout' });
    expect((await ok(call(s, 'GET', `/me/orders/${order.id}`))).history.map((h: { status: string }) => h.status)).toEqual(['pending_payment', 'placed', 'accepted', 'ready', 'completed']);
    expect(await types(s)).toContain('commerce.order_completed');

    // Picked up at the counter: the code given (or its QR scanned) hands it over.
    const pickup = await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'wave' }), 201);
    await pay(pickup.payment.reference);
    expect(json(await call(staff, 'POST', `/org/${orgId}/orders/handover`, { code: pickup.order.code })).code).toBe('ORDER_NOT_ACCEPTED');
    await ok(call(staff, 'POST', `/org/${orgId}/orders/${pickup.order.id}/accept`));
    expect(await ok(call(staff, 'POST', `/org/${orgId}/orders/handover`, { code: `UGBCMD:${pickup.order.code.toLowerCase()}` }))).toMatchObject({ id: pickup.order.id, status: 'completed' });
    expect(json(await call(staff, 'POST', `/org/${orgId}/orders/handover`, { code: pickup.order.code })).code).toBe('ORDER_ALREADY_DONE');
    expect((await call(staff, 'POST', `/org/${orgId}/orders/handover`, { code: 'CZZZZZZ' })).statusCode).toBe(404);

    // Refused: refunded, with the reason.
    const second = await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'wave' }), 201);
    await pay(second.payment.reference);
    const refused = await ok(call(owner, 'POST', `/org/${orgId}/orders/${second.order.id}/refuse`, { reason: 'Plus de mafé ce soir.' }));
    expect(refused).toMatchObject({ status: 'refused', refusal: 'Plus de mafé ce soir.', refunded: true });
    expect(await types(s)).toContain('commerce.order_refused');
    // Other businesses can't touch it.
    const other = await business('restaurant');
    expect((await call(other.owner, 'GET', `/org/${orgId}/orders/${order.id}`)).statusCode).toBe(404);
  });

  it('closed outside its hours, or paused by its owner', async () => {
    const { b, owner, orgId } = await business('restaurant', { services: [{ start: '12:00', end: '15:00' }, { start: '19:00', end: '22:00' }] });
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/catalog`, { section: 'menu', name: 'Mafé', price: 1500 }), 201);
    const s = await registerStudent(t);
    expect(await ok(call(s, 'GET', `/businesses/${b.id}`))).toMatchObject({ open: false, statusLabel: 'Fermé · ouvre à 12h', hours: '12h-15h · 19h-22h' });
    expect(json(await call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'wave' })).code).toBe('BUSINESS_CLOSED');
    t.clock.set(T0 + 3 * 3_600_000); // 13:00
    await ok(call(owner, 'PATCH', `/org/${orgId}/business`, { acceptingOrders: false }));
    expect(await ok(call(s, 'GET', `/businesses/${b.id}`))).toMatchObject({ open: false, statusLabel: 'Commandes en pause' });
  });
});

describe('shops', () => {
  it('articles with stock: taken by an order, given back when cancelled or unpaid', async () => {
    const { b, owner, orgId } = await business('shop');
    const pen = await ok(call(owner, 'POST', `/org/${orgId}/catalog`, { section: 'article', category: 'Fournitures', name: 'Stylo bleu', price: 200, stock: 2 }), 201);
    const a = await registerStudent(t);
    const c = await registerStudent(t);
    const first = await ok(call(a, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 2 }], mode: 'pickup', method: 'wave' }), 201);
    expect(json(await call(c, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 1 }], mode: 'pickup', method: 'wave' })).code).toBe('OUT_OF_STOCK');
    expect((await ok(call(c, 'GET', `/businesses/${b.id}`))).items[0]).toMatchObject({ stock: 0, soldOut: true });
    // Paid then cancelled before the shop takes it: refunded, the stock comes back.
    await pay(first.payment.reference);
    expect(await ok(call(a, 'POST', `/me/orders/${first.order.id}/cancel`))).toMatchObject({ status: 'cancelled', refunded: true });
    expect(await types(owner)).toContain('commerce.order_cancelled');
    expect((await ok(call(c, 'GET', `/businesses/${b.id}`))).items[0].stock).toBe(2);
    await ok(call(c, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 1 }], mode: 'pickup', method: 'wave' }), 201);
    // The market: every shop's articles together, each with its shop.
    const market = await ok(call(c, 'GET', '/market?kind=shop'));
    expect(market.businesses.some((x: { id: string }) => x.id === b.id)).toBe(true);
    expect(market.items.find((i: { id: string }) => i.id === pen.id)).toMatchObject({ businessId: b.id, name: 'Stylo bleu', category: 'Fournitures' });
    expect((await ok(call(c, 'GET', '/businesses?kind=shop'))).items.find((x: { id: string }) => x.id === b.id).itemNames).toEqual(['Stylo bleu']);
    // Students list only shops here.
    expect((await ok(call(c, 'GET', '/businesses?kind=shop'))).items.some((x: { id: string }) => x.id === b.id)).toBe(true);
    expect((await ok(call(c, 'GET', '/businesses?kind=restaurant'))).items.some((x: { id: string }) => x.id === b.id)).toBe(false);
  });
});
