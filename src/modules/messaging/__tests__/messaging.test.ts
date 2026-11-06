import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { bearer, createStaff, createTestApp, json, registerStudent, T0, type TestApp } from '../../../../test/harness.js';

// Conversations are created by their owning feature: these tests go through Sunu Taxi, the first one.
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true', TAXI_ONLINE_PAYMENT: 'true' });
});
afterAll(async () => t.close());

const MIN = 60_000;
type Student = Awaited<ReturnType<typeof registerStudent>>;

const tokenOf = async (s: { userId: string }) => (await t.c.modules.identity.startSession({ _id: new ObjectId(s.userId), platformRoles: [] })).accessToken;

async function call(s: Student, method: 'GET' | 'POST', url: string, payload?: object) {
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(await tokenOf(s)), payload });
}

let seq = 0;
const say = (s: Student, conversationId: string, body: string, clientMessageId = `msg-${Date.now()}-${++seq}`) =>
  call(s, 'POST', `/conversations/${conversationId}/messages`, { body, clientMessageId });

/** Organizer + paid passengers, with the trip chat id as each of them sees it. */
async function tripWith(passengers: number, over: { leaveInMinutes?: number } = {}) {
  t.clock.set(T0);
  const org = await registerStudent(t);
  const trip = json(await call(org, 'POST', '/taxi/trips', { from: 'UGB · Village E', to: 'Saint-Louis · Gare routière', seats: 4, fare: 3000, leaveInMinutes: over.leaveInMinutes ?? 60, lockMinutes: 30 }));
  const riders: Student[] = [];
  for (let i = 0; i < passengers; i++) {
    const s = await registerStudent(t);
    const { payment } = json(await call(s, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'wave' }));
    await t.app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${payment.reference}/pay`, headers: { 'content-type': 'text/plain' }, payload: '' });
    riders.push(s);
  }
  const conversationId = json(await call(org, 'GET', `/taxi/trips/${trip.id}`)).conversationId as string;
  return { org, riders, tripId: trip.id as string, conversationId };
}

const bodies = (res: { body: string }) => json(res).items.map((m: { body: string }) => m.body);

describe('access', () => {
  it('only the trip’s people get the chat; others don’t even learn it exists', async () => {
    const { org, riders, tripId, conversationId } = await tripWith(1);
    expect(conversationId).toMatch(/^[a-f0-9]{24}$/);
    expect(json(await call(riders[0]!, 'GET', `/taxi/trips/${tripId}`)).conversationId).toBe(conversationId);
    const outsider = await registerStudent(t);
    expect(json(await call(outsider, 'GET', `/taxi/trips/${tripId}`)).conversationId).toBeNull();
    expect((await call(outsider, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(404);
    expect((await say(outsider, conversationId, 'Salut')).statusCode).toBe(404);

    const conv = json(await call(org, 'GET', `/conversations/${conversationId}`));
    expect(conv).toMatchObject({ type: 'taxi_trip', contextRef: tripId, canWrite: true, me: { role: 'organizer', name: 'Awa D.' } });
    expect(conv.members).toHaveLength(2);
    expect(JSON.stringify(conv)).not.toContain(org.userId);
  });

  it('the app writes system lines: published, joined', async () => {
    const { org, conversationId } = await tripWith(1);
    expect(bodies(await call(org, 'GET', `/conversations/${conversationId}/messages`))).toEqual([
      'Trajet publié. La discussion est réservée aux passagers qui ont payé leur place.',
      'Awa a rejoint le trajet',
    ]);
  });

  it('leaving before the lock removes access; after the lock the chat stays readable, not writable', async () => {
    const { riders, tripId, conversationId } = await tripWith(2);
    const [early, late] = riders as [Student, Student];
    await call(early, 'POST', `/taxi/trips/${tripId}/leave`);
    expect((await call(early, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(404);

    t.clock.advance(31 * MIN);
    await call(late, 'POST', `/taxi/trips/${tripId}/leave`);
    expect(json(await call(late, 'GET', `/conversations/${conversationId}`)).canWrite).toBe(false);
    const res = await say(late, conversationId, 'Je ne viens plus');
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('CHAT_READ_ONLY');
  });

  it('read-only 2 h after departure, closed when the trip is cancelled', async () => {
    const { org, riders, tripId, conversationId } = await tripWith(1);
    t.clock.advance(3 * 60 * MIN);
    expect((await say(org, conversationId, 'Merci à tous')).statusCode).toBe(403);
    t.clock.set(T0);
    await call(org, 'POST', `/taxi/trips/${tripId}/cancel`);
    expect(json(await call(riders[0]!, 'GET', `/conversations/${conversationId}`))).toMatchObject({ status: 'closed', canWrite: false });
  });
});

describe('messages', () => {
  it('a retried send posts once; pages come oldest first; `after` fills a gap', async () => {
    const { org, riders, conversationId } = await tripWith(1);
    const first = await say(org, conversationId, 'Je suis devant la boutique', 'retry-me-0001');
    expect(first.statusCode).toBe(201);
    const again = await say(org, conversationId, 'Je suis devant la boutique', 'retry-me-0001');
    expect(again.statusCode).toBe(200);
    expect(json(again).id).toBe(json(first).id);
    await say(riders[0]!, conversationId, 'J’arrive dans 5 min');

    const all = json(await call(org, 'GET', `/conversations/${conversationId}/messages`)).items;
    expect(all.map((m: { body: string }) => m.body).slice(-2)).toEqual(['Je suis devant la boutique', 'J’arrive dans 5 min']);
    expect(all.at(-1).author).toMatchObject({ name: 'Awa D.', role: 'passenger' });
    const missed = json(await call(org, 'GET', `/conversations/${conversationId}/messages?after=${json(first).id}`)).items;
    expect(missed.map((m: { body: string }) => m.body)).toEqual(['J’arrive dans 5 min']);
  });

  it('unread counts others’ messages only, until read', async () => {
    const { org, riders, conversationId } = await tripWith(1);
    await say(org, conversationId, 'Un');
    const last = json(await say(org, conversationId, 'Deux'));
    const rider = riders[0]!;
    const list = json(await call(rider, 'GET', '/conversations?type=taxi_trip')).items;
    expect(list.find((c: { id: string }) => c.id === conversationId)).toMatchObject({ unread: 2, lastMessage: { body: 'Deux' } });
    expect(json(await call(org, 'GET', `/conversations/${conversationId}`)).unread).toBe(0);
    expect((await call(rider, 'POST', `/conversations/${conversationId}/read`, { lastReadMessageId: last.id })).statusCode).toBe(204);
    expect(json(await call(rider, 'GET', `/conversations/${conversationId}`)).unread).toBe(0);
  });

  it('blocking hides someone everywhere; reports reach the team', async () => {
    const { org, riders, conversationId } = await tripWith(1);
    const rude = json(await say(org, conversationId, 'Message déplacé'));
    const rider = riders[0]!;
    expect((await call(rider, 'POST', `/conversations/${conversationId}/messages/${rude.id}/report`, { reason: 'insulte' })).statusCode).toBe(204);
    expect((await call(rider, 'POST', `/conversations/${conversationId}/messages/${rude.id}/block-author`)).statusCode).toBe(204);
    expect(bodies(await call(rider, 'GET', `/conversations/${conversationId}/messages`))).not.toContain('Message déplacé');
    expect(json(await call(rider, 'GET', `/conversations/${conversationId}`)).blockedKeys).toEqual([rude.author.key]);
    expect(json(await call(org, 'POST', `/conversations/${conversationId}/messages/${rude.id}/block-author`)).code).toBe('OWN_MESSAGE');

    const admin = await createStaff(t, ['admin']);
    const reports = json(await t.app.inject({ method: 'GET', url: '/api/v1/admin/message-reports', headers: bearer(admin.tokens.accessToken) })).items;
    expect(reports.find((r: { messageId: string }) => r.messageId === rude.id)).toMatchObject({ body: 'Message déplacé', reason: 'insulte', conversationType: 'taxi_trip' });
  });
});

describe('real time', () => {
  /** Collects every frame; `next` waits for the first one matching. */
  async function connect() {
    const ws: WebSocket = await t.app.injectWS('/api/v1/ws');
    const frames: Record<string, unknown>[] = [];
    const waiters: { match: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }[] = [];
    ws.on('message', (raw: Buffer) => {
      const f = JSON.parse(raw.toString());
      frames.push(f);
      for (const w of [...waiters]) {
        if (!w.match(f)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    });
    const next = (match: (f: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const found = frames.find(match);
        if (found) return resolve(found);
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`no frame; got ${JSON.stringify(frames)}`)), 3000);
      });
    return { ws, next, send: (f: object) => ws.send(JSON.stringify(f)) };
  }

  it('members receive new messages live; outsiders can’t subscribe', async () => {
    const { org, riders, conversationId } = await tripWith(1);
    const rider = await connect();
    rider.send({ type: 'auth', accessToken: await tokenOf(riders[0]!) });
    await rider.next((f) => f.type === 'ready');
    rider.send({ type: 'sub', topic: `conversation:${conversationId}` });
    await rider.next((f) => f.type === 'subscribed');

    await say(org, conversationId, 'Je suis en route');
    const live = await rider.next((f) => f.type === 'event' && f.event === 'message.created');
    expect(live).toMatchObject({ topic: `conversation:${conversationId}`, data: { message: { body: 'Je suis en route', author: { role: 'organizer' } } } });
    // The badge channel: every member's own topic.
    await rider.next((f) => f.type === 'event' && f.event === 'conversation.activity');

    const outsider = await connect();
    outsider.send({ type: 'auth', accessToken: await tokenOf(await registerStudent(t)) });
    await outsider.next((f) => f.type === 'ready');
    outsider.send({ type: 'sub', topic: `conversation:${conversationId}` });
    expect(await outsider.next((f) => f.type === 'error')).toMatchObject({ code: 'FORBIDDEN' });
    rider.ws.terminate();
    outsider.ws.terminate();
  });

  it('a passenger who leaves stops receiving at once', async () => {
    const { riders, tripId, conversationId } = await tripWith(1);
    const rider = await connect();
    rider.send({ type: 'auth', accessToken: await tokenOf(riders[0]!) });
    await rider.next((f) => f.type === 'ready');
    rider.send({ type: 'sub', topic: `conversation:${conversationId}` });
    await rider.next((f) => f.type === 'subscribed');
    await call(riders[0]!, 'POST', `/taxi/trips/${tripId}/leave`);
    expect(await rider.next((f) => f.type === 'unsubscribed')).toMatchObject({ topic: `conversation:${conversationId}`, reason: 'revoked' });
    rider.ws.terminate();
  });

  it('refuses a bad token', async () => {
    const ws: WebSocket = await t.app.injectWS('/api/v1/ws');
    const closed = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));
    ws.send(JSON.stringify({ type: 'auth', accessToken: 'not-a-token' }));
    expect(await closed).toBe(4401);
  });
});
