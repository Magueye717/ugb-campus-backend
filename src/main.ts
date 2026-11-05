import { createRequire } from 'node:module';

import pino from 'pino';

import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createContainer } from './container.js';
import { runMigrate } from './migrate.js';
import { startWorkers } from './worker.js';

const role = process.argv[2] ?? 'api';
const config = loadConfig();
// Readable logs on a developer's machine; JSON elsewhere, and whenever pino-pretty (a dev dependency) isn't installed.
const hasPretty = (() => {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();
const log = pino({ level: config.LOG_LEVEL, ...(config.NODE_ENV === 'development' && hasPretty ? { transport: { target: 'pino-pretty' } } : {}) });

// Deploys run this before the new version starts (Render's pre-deploy command). Needs only MongoDB.
if (role === 'migrate') {
  await runMigrate(config, log);
  process.exit(0);
}

const container = await createContainer(config, { warn: (m) => log.warn(m) });
const state = { shuttingDown: false };
let stop: () => Promise<void>;

if (role === 'api') {
  const app = await buildApp(container, state);
  await app.listen({ host: config.HOST, port: config.PORT });
  stop = async () => {
    await app.close(); // stops accepting, drains in-flight requests
  };
} else if (role === 'worker') {
  const workers = await startWorkers(container, log);
  log.info({ queues: workers.map((w) => w.name) }, 'worker started');
  stop = async () => {
    await Promise.all(workers.map((w) => w.close())); // finishes the current jobs
  };
} else {
  log.error(`Unknown role "${role}": use "api", "worker" or "migrate".`);
  process.exit(1);
}

// Graceful shutdown: fail readiness first so the load balancer stops routing, then drain, then close connections.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutting down');
    state.shuttingDown = true;
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    try {
      await stop();
      await container.close();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  });
}
