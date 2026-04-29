import pino, { type Logger } from 'pino';

import type { Config } from './config';

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'meetpr-backend', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type { Logger };
