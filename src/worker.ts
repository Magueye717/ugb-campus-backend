import type { Worker } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';

import type { Container } from './container.js';
import { createSmsSender } from './platform/sms/sms.js';

/** Starts one BullMQ worker per queue, with the processors each module exposes, and keeps the repeating jobs scheduled. */
export async function startWorkers(c: Container, log: FastifyBaseLogger): Promise<Worker[]> {
  const sms = createSmsSender(c.config, log);
  const { identity, payments, taxi, ticketing, caravans, notifications, alerts, events, commerce, ratings, media } = c.modules;
  const processors = {
    ...identity.processors(sms), ...payments.processors(), ...taxi.processors(), ...ticketing.processors(), ...caravans.processors(), ...notifications.processors(log), ...alerts.processors(), ...events.processors(), ...commerce.processors(), ...ratings.processors(), ...media.processors(),
  };
  // Idempotent: one scheduler per queue, whatever the number of worker instances.
  for (const { queue, everyMs } of [...payments.schedules, ...taxi.schedules, ...ticketing.schedules, ...caravans.schedules, ...alerts.schedules, ...events.schedules, ...commerce.schedules, ...ratings.schedules, ...media.schedules]) {
    await c.queues.get(queue).upsertJobScheduler(queue, { every: everyMs }, { name: queue });
  }
  return Object.entries(processors).map(([queue, processor]) => {
    const worker = c.queues.worker(queue, processor as never);
    worker.on('failed', (job, err) => log.warn({ queue, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
    worker.on('error', (err) => log.error({ queue, err }, 'worker error'));
    return worker;
  });
}
