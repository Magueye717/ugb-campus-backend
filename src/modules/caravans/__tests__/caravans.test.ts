import { createPublicKey, verify } from 'node:crypto';

import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, nextPhone, registerStudent, T0, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true' });
});
afterAll(async () => t.close());

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
type Who = { userId: string };

async function call(who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(who.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
const pay = (reference: string, action: 'pay' | 'fail' = 'pay') =>
  t.app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${reference}/${action}`, headers: { 'content-type': 'text/plain' }, payload: '' });
const at = (ms: number) => new Date(T0 + ms).toISOString();

let seq = 0;
/** An organization with an owner and a scanner, a 12-seat minibus, and a published departure in 3 days. */
async function setup(over: { minPassengers?: number; departIn?: number; paymentMethods?: string[] } = {}) {
  t.clock.set(T0);
  const owner = await createStaff(t);
  const scanner = await createStaff(t);
  const org = await t.c.modules.organizations.create({ slug: `org-${++seq}-${Date.now() % 1e6}`, name: 'Khoulé & Frère', category: 'Entreprise', capabilities: ['caravans'], level: 'confirme', payoutPhone: owner.phone });
  await t.c.modules.organizations.setOwner(org._id, owner.phone, null);
  await t.c.modules.organizations.setMember(org._id, 'organizer', { phone: scanner.phone, roles: ['scanner'] }, null);
  const o = { userId: owner.userId.toHexString() };
  const orgId = org._id.toHexString();
  const vehicle = await ok(call(o, 'POST', `/org/${orgId}/vehicles`, { label: 'Minibus 12 places', plate: `DK ${1000 + seq} AB`, capacity: 12 }), 201);
  const start = over.departIn ?? 3 * DAY;
  const draft = await ok(
    call(o, 'POST', `/org/${orgId}/departures`, {
      vehicleId: vehicle.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: over.minPassengers ?? 2, ...(over.paymentMethods ? { paymentMethods: over.paymentMethods } : {}),
      pickups: [{ place: 'UGB · Village E', at: at(start) }, { place: 'Saint-Louis · Gare routière', at: at(start + 40 * MIN) }],
      dropoffs: [{ place: 'Thiès · Mairie', at: at(start + 4 * HOUR) }, { place: 'Dakar · Colobane', at: at(start + 5.5 * HOUR) }],
    }),
    201,
  );
  expect(draft.status).toBe('draft');
  const dep = await ok(call(o, 'POST', `/org/${orgId}/departures/${draft.id}/publish`));
  return { owner: o, scanner: { userId: scanner.userId.toHexString() }, orgId, dep };
}

/** Books (auto or chosen seat) and pays through the simulator; returns the ticket. */
async function buy(s: Who, depId: string, body: object = {}) {
  const { booking, payment } = await ok(call(s, 'POST', `/caravans/departures/${depId}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd2', method: 'wave', ...body }), 201);
  expect(booking.status).toBe('held');
  await pay(payment.reference);
  const done = await ok(call(s, 'GET', `/caravans/bookings/${booking.id}`));
  expect(done).toMatchObject({ status: 'confirmed' });
  return ok(call(s, 'GET', `/tickets/${done.ticketId}`));
}

describe('browse and book', () => {
  it('the organizer chooses the providers: one only, the other is refused', async () => {
    const { dep } = await setup({ paymentMethods: ['wave'] });
    expect(dep.paymentMethods).toEqual(['wave']);
    const s = await registerStudent(t);
    const refused = await call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd2', method: 'orange_money' });
    expect(json(refused).field).toBe('method');
    expect((await setup()).dep.paymentMethods).toEqual(['wave', 'orange_money']);
  });

  it('lists published departures; the plate is for ticket holders only', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    const listed = (await ok(call(s, 'GET', '/caravans/departures?direction=aller'))).items.find((d: { id: string }) => d.id === dep.id);
    expect(listed).toMatchObject({ from: 'UGB', to: 'Dakar', price: 3500, totalSeats: 12, seatsFree: 12, confirmed: false, bookingOpen: true, myTicketId: null, vehicle: { plate: null } });
    expect(listed.pickups.map((p: { stopId: string }) => p.stopId)).toEqual(['p1', 'p2']);
    const seats = await ok(call(s, 'GET', `/caravans/departures/${dep.id}/seats`));
    expect(seats).toMatchObject({ capacity: 12, seatsPerRow: 4, taken: [], suggested: 1 });

    const ticket = await buy(s, dep.id);
    expect(ticket).toMatchObject({ kind: 'caravan_seat', status: 'active', seat: 1, price: 3500, event: { title: 'UGB → Dakar' }, details: { pickup: { place: 'UGB · Village E' }, dropoff: { place: 'Dakar · Colobane' } } });
    expect(ticket.code).toMatch(/^[0-9A-Z]{6}$/);
    expect(ticket.qr).toBeTruthy();
    const after = await ok(call(s, 'GET', `/caravans/departures/${dep.id}`));
    expect(after).toMatchObject({ myTicketId: ticket.id, seatsFree: 11, seatsBooked: 1, vehicle: { plate: expect.stringMatching(/^DK-/) } });
  });

  it('auto-pick takes window seats front to back; a chosen seat taken a moment ago is refused', async () => {
    const { dep } = await setup();
    const [a, b, c] = [await registerStudent(t), await registerStudent(t), await registerStudent(t)];
    expect((await buy(a, dep.id)).seat).toBe(1);
    expect((await buy(b, dep.id)).seat).toBe(4);
    const race = await Promise.all([c, await registerStudent(t)].map((s) => call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { seat: 6, pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' })));
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(json(race.find((r) => r.statusCode === 409)!).code).toBe('SEAT_TAKEN');
    expect((await ok(call(c, 'GET', `/caravans/departures/${dep.id}/seats`))).taken).toEqual([1, 4, 6]);
  });

  it('one seat for yourself per departure; bad stops refused', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    await buy(s, dep.id);
    expect(json(await call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' })).code).toBe('ALREADY_BOOKED');
    const other = await registerStudent(t);
    expect((await call(other, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'd1', dropoffStopId: 'p1', method: 'wave' })).statusCode).toBe(400);
  });

  it('an unpaid seat goes back after 10 min; releasing it is immediate', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    const { booking } = await ok(call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' }), 201);
    t.clock.advance(11 * MIN);
    await t.c.modules.payments.sweep();
    expect(await ok(call(s, 'GET', `/caravans/bookings/${booking.id}`))).toMatchObject({ status: 'expired' });
    const again = await ok(call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' }), 201);
    expect((await call(s, 'DELETE', `/caravans/bookings/${again.booking.id}`)).statusCode).toBe(204);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).seatsFree).toBe(12);
  });

  it('the departure is confirmed once the minimum is paid', async () => {
    const { dep } = await setup({ minPassengers: 2 });
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    await buy(a, dep.id);
    expect((await ok(call(a, 'GET', `/caravans/departures/${dep.id}`))).confirmed).toBe(false);
    await buy(b, dep.id);
    expect(await ok(call(a, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ confirmed: true, status: 'confirmed' });
  });
});

describe('cancel', () => {
  it('free until 24 h before, then 10 %; refused once the bus has left; the seat is sold again', async () => {
    const { dep } = await setup();
    const [early, late] = [await registerStudent(t), await registerStudent(t)];
    const t1 = await buy(early, dep.id);
    expect(t1.cancellationQuote).toMatchObject({ allowed: true, fee: 0, refund: 3500 });
    expect(await ok(call(early, 'POST', `/tickets/${t1.id}/cancel`))).toEqual({ refundAmount: 3500, fee: 0 });
    expect(await t.c.mongo.db.collection('payouts').findOne({ idempotencyKey: `ticket:${t1.id}:cancel` })).toMatchObject({ amount: 3500, reason: 'ticket_cancelled' });
    expect((await ok(call(early, 'GET', `/tickets/${t1.id}`))).status).toBe('cancelled');
    expect((await buy(early, dep.id)).seat).toBe(1); // can book again after cancelling

    const t2 = await buy(late, dep.id);
    t.clock.advance(3 * DAY - 12 * HOUR);
    expect(await ok(call(late, 'POST', `/tickets/${t2.id}/cancel`))).toEqual({ refundAmount: 3150, fee: 350 });
    t.clock.advance(13 * HOUR);
    const t3 = (await ok(call(early, 'GET', '/tickets'))).items.find((x: { status: string }) => x.status === 'active');
    expect(json(await call(early, 'POST', `/tickets/${t3.id}/cancel`)).code).toBe('CANCELLATION_REFUSED');
  });
});

describe('transfer to a friend', () => {
  it('the friend must be a student, accepts, and gets a new QR; the old one is refused', async () => {
    const { dep, orgId, scanner } = await setup();
    const [from, friend] = [await registerStudent(t), await registerStudent(t)];
    const ticket = await buy(from, dep.id);
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: nextPhone() })).code).toBe('RECIPIENT_NOT_FOUND');
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: from.phone })).code).toBe('SELF_TRANSFER');

    const offer = await ok(call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone }), 201);
    expect(offer).toMatchObject({ status: 'pending', to: { name: 'Awa D.' } });
    const incoming = (await ok(call(friend, 'GET', '/ticket-transfers?direction=incoming'))).items;
    expect(incoming[0]).toMatchObject({ id: offer.id, seat: 1, event: { title: 'UGB → Dakar' } });
    expect(await ok(call(friend, 'POST', `/ticket-transfers/${offer.id}/accept`))).toEqual({ status: 'accepted', ticketId: ticket.id });

    const mine = await ok(call(friend, 'GET', `/tickets/${ticket.id}`));
    expect(mine).toMatchObject({ status: 'active', seat: 1 });
    expect(mine.qr).not.toBe(ticket.qr);
    expect(await ok(call(from, 'GET', `/tickets/${ticket.id}`))).toMatchObject({ status: 'transferred', qr: null, transfer: { status: 'accepted' } });
    // The given ticket still counts in the 2 purchases allowed: one more seat, then no more.
    await buy(from, dep.id);
    expect(json(await call(from, 'POST', `/caravans/departures/${dep.id}/bookings`, { seats: [{ passenger: { name: 'Ami Trois', phone: nextPhone() } }], pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' })).code).toBe('SEAT_LIMIT');

    t.clock.set(T0 + 3 * DAY - HOUR);
    const stale = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr, clientScanId: 'scan-stale-0001' }));
    expect(stale).toMatchObject({ result: 'rejected', reason: 'stale_version' });
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: mine.qr, clientScanId: 'scan-new-0001' }))).toMatchObject({ result: 'admitted' });
  });

  it('declined, withdrawn, or too late', async () => {
    const { dep } = await setup();
    const [from, friend] = [await registerStudent(t), await registerStudent(t)];
    const ticket = await buy(from, dep.id);
    const o1 = await ok(call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone }), 201);
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone })).code).toBe('TRANSFER_PENDING');
    await ok(call(friend, 'POST', `/ticket-transfers/${o1.id}/decline`));
    const o2 = await ok(call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone }), 201);
    expect((await call(from, 'POST', `/ticket-transfers/${o2.id}/cancel`)).statusCode).toBe(204);
    expect(json(await call(friend, 'POST', `/ticket-transfers/${o2.id}/accept`)).code).toBe('TRANSFER_EXPIRED');
    t.clock.set(T0 + 3 * DAY - HOUR);
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone })).code).toBe('TRANSFER_CLOSED');
  });
});

describe('boarding', () => {
  it('scan, duplicate, typed code, manual, unboard; other organizers and early scans refused', async () => {
    const { dep, orgId, owner, scanner } = await setup();
    const [a, b, c] = [await registerStudent(t), await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    const tb = await buy(b, dep.id, { pickupStopId: 'p2' });
    const tc = await buy(c, dep.id);

    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'early-scan-01' }))).toMatchObject({ result: 'rejected', reason: 'too_early' });
    t.clock.set(T0 + 3 * DAY - 30 * MIN);

    const first = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'scan-a-000001' }));
    expect(first).toMatchObject({ result: 'admitted', tone: 'success', title: 'Awa Diop · place 1', ticket: { id: ta.id } });
    expect(first.text).toContain('Descend à Dakar · Colobane');
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'scan-a-000001' }))).toMatchObject({ result: 'admitted', text: 'Scan déjà enregistré.' });
    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'scan-a-000002' }))).toMatchObject({ result: 'duplicate', title: 'Déjà à bord' });

    // b booked Saint-Louis but gets on at the first stop: boarded, with a warning.
    const typed = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { code: tb.code.toLowerCase(), clientScanId: 'scan-b-000001' }));
    expect(typed).toMatchObject({ result: 'admitted', tone: 'warning' });
    expect(typed.text).toContain('au lieu de Saint-Louis · Gare routière');
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { ticketId: tc.id, eventId: dep.id }))).toMatchObject({ result: 'admitted' });
    expect((await call(scanner, 'POST', `/org/${orgId}/tickets/${tc.id}/admission/void`, { reason: 'erreur' })).statusCode).toBe(204);

    const manifest = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/manifest`));
    expect(manifest.departure.counts).toEqual({ booked: 3, buyers: 3, admitted: 2 });
    expect(manifest.passengers.find((p: { ticketId: string }) => p.ticketId === tc.id)).toMatchObject({ admitted: false, name: 'Awa Diop', phone: expect.stringMatching(/^\+221 7/) });

    const rival = await setup();
    t.clock.set(T0 + 3 * DAY - 30 * MIN);
    expect(await ok(call(rival.scanner, 'POST', `/org/${rival.orgId}/admissions`, { qr: tb.qr, clientScanId: 'rival-scan-01' }))).toMatchObject({ result: 'rejected', reason: 'wrong_org' });
    expect((await call(rival.scanner, 'GET', `/org/${rival.orgId}/departures/${dep.id}/manifest`)).statusCode).toBe(404);
    expect((await call(scanner, 'GET', `/org/${rival.orgId}/departures`)).statusCode).toBe(404);
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: 'not.a.ticket', clientScanId: 'junk-scan-01' }))).toMatchObject({ result: 'rejected', reason: 'bad_signature' });
  });

  it('leaving the first stop starts the trip; who wasn’t scanned there is absent; the owner claims the money once', async () => {
    const { dep, orgId, owner, scanner } = await setup({ minPassengers: 1 });
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    const tb = await buy(b, dep.id);
    t.clock.set(T0 + 3 * DAY);
    await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'leave-scan-1' }));
    expect(json(await call(owner, 'POST', `/org/${orgId}/departures/${dep.id}/claim`, { method: 'wave' })).code).toBe('DEPARTURE_NOT_DEPARTED');
    const left = await ok(call(scanner, 'POST', `/org/${orgId}/departures/${dep.id}/stops/p1/leave`));
    expect(left.absent).toEqual([{ ticketId: tb.id, seat: tb.seat }]);
    expect((await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}`))).status).toBe('departed');

    expect((await call(scanner, 'POST', `/org/${orgId}/departures/${dep.id}/claim`, { method: 'wave' })).statusCode).toBe(404); // owner only
    const claim = await ok(call(owner, 'POST', `/org/${orgId}/departures/${dep.id}/claim`, { method: 'orange_money' }));
    expect(claim).toMatchObject({ kind: 'organizer_claim', amount: 7000, method: 'orange_money', status: 'requested' });
    expect((await ok(call(owner, 'POST', `/org/${orgId}/departures/${dep.id}/claim`, { method: 'wave' }))).id).toBe(claim.id);
  });
});

describe('cancelled departures', () => {
  it('minimum not reached at the deadline: cancelled, everyone refunded 100 %', async () => {
    const { dep } = await setup({ minPassengers: 3 });
    const s = await registerStudent(t);
    const ticket = await buy(s, dep.id);
    t.clock.set(T0 + 2 * DAY + MIN);
    await t.c.modules.caravans.service.sweep();
    expect(await ok(call(s, 'GET', `/tickets/${ticket.id}`))).toMatchObject({ status: 'cancelled', cancellation: { reason: 'min_not_reached', refundAmount: 3500, fee: 0 } });
  });

  it('the organizer cancels: tickets refunded, unpaid holds released, nothing left to sell', async () => {
    const { dep, orgId, owner } = await setup();
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    await ok(call(b, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' }), 201);
    expect(await ok(call(owner, 'POST', `/org/${orgId}/departures/${dep.id}/cancel`, { reason: 'Panne du bus' }))).toEqual({ refunded: 1 });
    expect((await ok(call(a, 'GET', `/tickets/${ta.id}`))).cancellation).toMatchObject({ reason: 'event_cancelled', refundAmount: 3500 });
    expect((await ok(call(a, 'GET', '/caravans/departures'))).items.some((d: { id: string }) => d.id === dep.id)).toBe(false);
  });
});

describe('offline scanning', () => {
  it('the pack verifies QR codes without the server; scans synced later count once', async () => {
    const { dep, orgId, scanner, owner } = await setup();
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    const tb = await buy(b, dep.id);
    const pack = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/offline-pack`));
    expect(pack.versions).toMatchObject({ [ta.id]: 1, [tb.id]: 1 });
    expect(pack.codes[tb.code]).toBe(tb.id);
    expect(pack.manifest.passengers).toHaveLength(2);

    // What the phone does offline: check the Ed25519 signature with the pack's public key only.
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pack.key.x }, format: 'jwk' });
    const [h, p, sig] = ta.qr.split('.');
    expect(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ sub: ta.id, e: dep.id, v: 1, aud: 'ticket' });

    // Two phones boarded `a` offline; synced later: the first one wins, the second is a duplicate.
    t.clock.set(T0 + 3 * DAY - 20 * MIN);
    const synced = await ok(
      call(scanner, 'POST', `/org/${orgId}/admissions/batch`, {
        items: [
          { qr: ta.qr, eventId: dep.id, clientScanId: 'offline-a-1', scannedAt: at(3 * DAY - 40 * MIN) },
          { code: tb.code, eventId: dep.id, clientScanId: 'offline-b-1', scannedAt: at(3 * DAY - 35 * MIN) },
        ],
      }),
    );
    expect(synced.items.map((r: { result: string }) => r.result)).toEqual(['admitted', 'admitted']);
    const other = await ok(call(owner, 'POST', `/org/${orgId}/admissions/batch`, { items: [{ qr: ta.qr, eventId: dep.id, clientScanId: 'offline-a-2' }] }));
    expect(other.items[0]).toMatchObject({ result: 'duplicate' });
    // Re-sent by a phone that didn't get the answer: same result, nothing recorded twice.
    const again = await ok(call(scanner, 'POST', `/org/${orgId}/admissions/batch`, { items: [{ qr: ta.qr, eventId: dep.id, clientScanId: 'offline-a-1' }] }));
    expect(again.items[0]).toMatchObject({ result: 'admitted', text: 'Scan déjà enregistré.' });
    expect((await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}`))).counts).toEqual({ booked: 2, buyers: 2, admitted: 2 });
  });
});

describe('a seat for a companion', () => {
  const companion = (name: string, phone: string, seat?: number) => ({ ...(seat ? { seat } : {}), passenger: { name, phone } });
  const bookSeats = (s: Who, depId: string, seats: object[]) => call(s, 'POST', `/caravans/departures/${depId}/bookings`, { seats, pickupStopId: 'p1', dropoffStopId: 'd2', method: 'wave' });

  it('two seats, one payment: the companion’s ticket carries their name and stays in the buyer’s app', async () => {
    const { dep } = await setup({ minPassengers: 2 });
    const s = await registerStudent(t);
    const awaPhone = nextPhone();
    const { booking, payment } = await ok(bookSeats(s, dep.id, [{ seat: 7 }, companion('  Awa   Ndiaye ', awaPhone, 8)]), 201);
    expect(payment.amount).toBe(7000);
    expect(booking.seats).toEqual([
      { seat: 7, passenger: null, status: 'held', ticketId: null },
      { seat: 8, passenger: { name: 'Awa Ndiaye', phone: expect.stringMatching(/^\+221 /) }, status: 'held', ticketId: null },
    ]);
    const held = await ok(call(s, 'GET', `/caravans/departures/${dep.id}`));
    expect(held).toMatchObject({ seatsFree: 10, mySeatsLeft: 0, maxSeatsPerStudent: 2, myBooking: { seats: [{ seat: 7 }, { seat: 8, passenger: { name: 'Awa Ndiaye' } }] } });

    await pay(payment.reference);
    const done = await ok(call(s, 'GET', `/caravans/bookings/${booking.id}`));
    expect(done.seats.map((x: { status: string }) => x.status)).toEqual(['confirmed', 'confirmed']);
    // Two paid seats: the minimum of 2 is reached.
    expect(await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ seatsBooked: 2, confirmed: true, myTicketId: done.seats[0].ticketId });
    const tickets = (await ok(call(s, 'GET', '/tickets'))).items.sort((a: { seat: number }, b: { seat: number }) => a.seat - b.seat);
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toMatchObject({ seat: 7, passenger: null, purchaser: { isMe: true } });
    expect(tickets[1]).toMatchObject({ seat: 8, status: 'active', passenger: { name: 'Awa Ndiaye' }, purchaser: { isMe: true } });
    expect(tickets[1].qr).toBeTruthy();
    expect(tickets[1].code).not.toBe(tickets[0].code);

    // A third seat: over the limit.
    expect(json(await bookSeats(s, dep.id, [companion('Ami Trois', nextPhone())])).code).toBe('SEAT_LIMIT');
    // Cancelling the companion's ticket refunds the buyer and frees a slot.
    expect(await ok(call(s, 'POST', `/tickets/${tickets[1].id}/cancel`))).toEqual({ refundAmount: 3500, fee: 0 });
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).mySeatsLeft).toBe(1);
  });

  it('refuses two seats for yourself, your own number, a number already travelling, and a third seat', async () => {
    const { dep } = await setup();
    const [s, other] = [await registerStudent(t), await registerStudent(t)];
    expect((await bookSeats(s, dep.id, [{}, {}])).statusCode).toBe(400);
    expect(json(await bookSeats(s, dep.id, [{}, companion('Moi Même', s.phone)])).fields?.[0]?.path ?? 'passenger.phone').toBe('passenger.phone');
    expect((await bookSeats(s, dep.id, [{}, companion('Moi Même', s.phone)])).statusCode).toBe(400);
    const p = nextPhone();
    expect((await bookSeats(s, dep.id, [companion('Awa', p), companion('Awa bis', p)])).statusCode).toBe(400);
    expect((await bookSeats(s, dep.id, [{}, companion('A', p)])).statusCode).toBe(400);
    expect(json(await bookSeats(s, dep.id, [{}, companion('Un', nextPhone()), companion('Deux', nextPhone())])).code).toBe('SEAT_LIMIT');

    await buy(other, dep.id);
    // Already has their own ticket, or is someone's companion already.
    expect(json(await bookSeats(s, dep.id, [{}, companion('Awa Diop', other.phone)])).code).toBe('PASSENGER_HAS_SEAT');
    const { payment } = await ok(bookSeats(other, dep.id, [companion('Fatou Sow', p)]), 201);
    await pay(payment.reference);
    expect(json(await bookSeats(s, dep.id, [{}, companion('Fatou Sow', p)])).code).toBe('PASSENGER_HAS_SEAT');
  });

  it('a departure limited to 1 seat per student; releasing an order frees all its seats', async () => {
    const { dep, orgId, owner } = await setup();
    const s = await registerStudent(t);
    const { booking } = await ok(bookSeats(s, dep.id, [{}, companion('Awa Ndiaye', nextPhone())]), 201);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}/seats`))).taken).toEqual([1, 4]);
    expect((await call(s, 'DELETE', `/caravans/bookings/${booking.id}`)).statusCode).toBe(204);
    expect(await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ seatsFree: 12, mySeatsLeft: 2, myBooking: null });

    // Paid too late for both seats: the whole order goes back.
    const late = await ok(bookSeats(s, dep.id, [{ seat: 2 }, companion('Awa Ndiaye', nextPhone(), 3)]), 201);
    t.clock.advance(11 * MIN);
    await t.c.modules.payments.sweep();
    expect((await ok(call(s, 'GET', `/caravans/bookings/${late.booking.id}`))).seats.map((x: { status: string }) => x.status)).toEqual(['expired', 'expired']);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).seatsFree).toBe(12);

    const vehicle = (await ok(call(owner, 'GET', `/org/${orgId}/vehicles`))).items[0];
    const strict = await ok(
      call(owner, 'POST', `/org/${orgId}/departures`, {
        vehicleId: vehicle.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: 0, maxSeatsPerStudent: 1,
        pickups: [{ place: 'UGB · Village E', at: at(5 * DAY) }], dropoffs: [{ place: 'Thiès · Mairie', at: at(5 * DAY + 4 * HOUR) }, { place: 'Dakar · Colobane', at: at(5 * DAY + 5 * HOUR) }],
      }),
      201,
    );
    await ok(call(owner, 'POST', `/org/${orgId}/departures/${strict.id}/publish`));
    expect(json(await bookSeats(s, strict.id, [{}, companion('Awa Ndiaye', nextPhone())])).code).toBe('SEAT_LIMIT');
    expect(json(await bookSeats(s, strict.id, [{}, companion('Awa Ndiaye', nextPhone())])).message).toBe('Une seule place par étudiant sur ce départ.');
  });

  it('two purchases at the same moment can’t go over the limit', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    await buy(s, dep.id);
    const race = await Promise.all([1, 2].map((i) => bookSeats(s, dep.id, [companion(`Ami ${i}`, nextPhone())])));
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(json(race.find((r) => r.statusCode === 409)!).code).toBe('SEAT_LIMIT');
  });

  it('a companion with an account is offered the ticket; accepting makes it theirs, the group stays visible', async () => {
    const { dep, orgId, scanner } = await setup();
    const [moussa, awa] = [await registerStudent(t), await registerStudent(t)];
    const { booking, payment } = await ok(bookSeats(moussa, dep.id, [{ seat: 7 }, companion('Awa Ndiaye', awa.phone, 8)]), 201);
    await pay(payment.reference);
    await new Promise((r) => setTimeout(r, 100)); // after-commit offer
    const incoming = (await ok(call(awa, 'GET', '/ticket-transfers?direction=incoming'))).items;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ seat: 8, from: { name: 'Awa D.' } });
    expect((await ok(call(awa, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'ticket.transfer_offered', title: 'Awa D. t’a réservé une place' });

    const done = await ok(call(moussa, 'GET', `/caravans/bookings/${booking.id}`));
    const companionTicket = done.seats[1].ticketId;
    expect(await ok(call(awa, 'POST', `/ticket-transfers/${incoming[0].id}/accept`))).toMatchObject({ status: 'accepted', ticketId: companionTicket });
    expect(await ok(call(awa, 'GET', `/tickets/${companionTicket}`))).toMatchObject({ status: 'active', passenger: null, purchaser: { isMe: false } });
    expect(await ok(call(awa, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ myTicketId: companionTicket });

    // On the list: still Moussa's group of 2, Awa now under her own account.
    const manifest = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/manifest`));
    expect(manifest.departure.counts).toEqual({ booked: 2, buyers: 1, admitted: 0 });
    const seat8 = manifest.passengers.find((p: { seat: number }) => p.seat === 8);
    expect(seat8).toMatchObject({ companionOf: null, transferred: true, purchaser: { id: moussa.userId }, groupSize: 2 });
  });

  it('on the list and at the scanner: the companion’s name, who booked, and the group to board together', async () => {
    const { dep, orgId, scanner } = await setup({ departIn: 2 * HOUR });
    const moussa = await registerStudent(t);
    const phone = nextPhone();
    const { payment } = await ok(bookSeats(moussa, dep.id, [{ seat: 7 }, companion('Awa Ndiaye', phone, 8)]), 201);
    await pay(payment.reference);
    const manifest = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/manifest`));
    expect(manifest.passengers).toEqual([
      expect.objectContaining({ seat: 7, name: 'Awa Diop', companionOf: null, groupSize: 2, purchaser: { id: moussa.userId, name: 'Awa Diop' } }),
      expect.objectContaining({ seat: 8, name: 'Awa Ndiaye', phone: expect.stringMatching(/^\+221 /), companionOf: 'Awa Diop', transferred: false, groupSize: 2 }),
    ]);
    const tickets = (await ok(call(moussa, 'GET', '/tickets'))).items;
    const t8 = tickets.find((x: { seat: number }) => x.seat === 8);
    const t7 = tickets.find((x: { seat: number }) => x.seat === 7);
    const scan = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: t8.qr, eventId: dep.id, locationId: 'p1' }));
    expect(scan).toMatchObject({
      result: 'admitted', title: 'Awa Ndiaye · place 8', holder: { name: 'Awa Ndiaye' }, companionOf: 'Awa Diop',
      group: { size: 2, purchaser: 'Awa Diop', others: [{ ticketId: t7.id, seat: 7, name: 'Awa Diop', admitted: false }] },
    });
    expect(scan.text).toContain('Accompagnant de Awa Diop.');
    expect(scan.text).toContain('pièce d’identité');
    // "Faire monter les 2": the other ticket by id.
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { ticketId: scan.group.others[0].ticketId, eventId: dep.id }))).toMatchObject({
      result: 'admitted', group: { others: [{ seat: 8, admitted: true }] },
    });
    const pack = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/offline-pack`));
    expect(pack.manifest.passengers.every((p: { admitted: boolean }) => p.admitted)).toBe(true);
  });
});
