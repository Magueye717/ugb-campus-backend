import type { FastifyServerOptions } from 'fastify';

import type { Config } from '../../config/env.js';

/** Fields never written to logs. Phone numbers are masked where they're logged on purpose. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.code',
  '*.refreshToken',
  '*.accessToken',
  '*.verificationToken',
  '*.secret',
  '*.proof',
  '*.cardNumber',
];

export function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.NODE_ENV === 'test') return false;
  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  };
}
