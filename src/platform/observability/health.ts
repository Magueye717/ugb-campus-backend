import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';

/** Liveness: the process answers. Readiness: its dependencies answer too (load balancers route on this one). */
export function registerHealthRoutes(app: FastifyInstance, deps: { db: Db; redis: Redis; isShuttingDown: () => boolean }) {
  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = { mongo: 'fail', redis: 'fail' };
    await Promise.all([
      deps.db.command({ ping: 1 }).then(() => (checks.mongo = 'ok'), () => undefined),
      deps.redis.ping().then(() => (checks.redis = 'ok'), () => undefined),
    ]);
    const ready = !deps.isShuttingDown() && Object.values(checks).every((c) => c === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
  });
}
