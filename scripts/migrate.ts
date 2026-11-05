import pino from 'pino';

import { loadConfig } from '../src/config/env.js';
import { runMigrate } from '../src/migrate.js';

// `npm run migrate`: the same step as a deploy's (src/migrate.ts), against the database in .env.
await runMigrate(loadConfig(), pino({ transport: { target: 'pino-pretty' } }));
