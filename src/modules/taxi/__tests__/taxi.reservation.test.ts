import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, json, registerStudent, T0, type TestApp } from '../../../../test/harness.js';

// The default: TAXI_ONLINE_PAYMENT off, a seat is a reservation.
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true' });
});
afterAll(async () => t.close());

type Student = Awaited<ReturnType<typeof registerStudent>>;
async function call(s: Student, method: 'GET' | 'POST', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(s.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
async function newTrip(org: Student) {
  const res = await call(org, 'POST', '/taxi/trips', { from: 'UGB · Village E', to: 'Saint-Louis · Gare routière', seats: 3, fare: 3000, leaveInMinutes: 60 });
  expect(res.statusCode, res.body).toBe(201);
  return json(res);
}

describe('reservation only (no payment in the app)', () => {
  it('a seat is taken at once, nothing to pay; leaving reopens it; cancelling refunds nobody; no payout', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org);
    expect(trip).toMatchObject({ payOnline: false, seatPrice: 1000, seatsTaken: 1 });

    const s = await registerStudent(t);
    const joined = await call(s, 'POST', `/taxi/trips/${trip.id}/join`, {});
    expect(joined.statusCode, joined.body).toBe(201);
    expect(json(joined)).toMatchObject({ payment: null, trip: { seatsTaken: 2, me: { status: 'joined', payment: null } } });
    // In the chat at once, and twice is the same seat.
    expect(json(joined).trip.conversationId).toBeTruthy();
    expect((await call(s, 'POST', `/taxi/trips/${trip.id}/join`, {})).statusCode).toBe(200);
    expect(await t.c.mongo.db.collection('payments').countDocuments({ userId: new ObjectId(s.userId) })).toBe(0);

    // Leaving, even late: nothing to refund, the seat reopens.
    t.clock.advance(55 * 60_000);
    expect(json(await call(s, 'GET', `/taxi/trips/${trip.id}/leave-quote`))).toEqual({ refundAmount: 0, locked: false });
    expect(json(await call(s, 'POST', `/taxi/trips/${trip.id}/leave`))).toMatchObject({ refundAmount: 0, forfeited: false });
    expect(json(await call(org, 'GET', `/taxi/trips/${trip.id}`)).seatsTaken).toBe(1);

    // Cancelled with someone in: no refund, no payout (the late cancellation still counts).
    const other = await registerStudent(t);
    await call(other, 'POST', `/taxi/trips/${trip.id}/join`, {});
    expect((await call(org, 'POST', `/taxi/trips/${trip.id}/cancel`)).statusCode).toBe(200);
    expect(await t.c.mongo.db.collection('payouts').countDocuments({ 'source.id': { $in: [new ObjectId(trip.id)] } })).toBe(0);
    expect(await t.c.mongo.db.collection('payouts').countDocuments({ beneficiaryUserId: new ObjectId(other.userId) })).toBe(0);
  });
});
