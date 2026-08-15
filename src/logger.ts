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
        'req.body.code',
        'req.body.newPassword',
        'req.body.new_password',
        'req.body.authorizationCode',
        'req.body.authorization_code',
        'req.body.refresh_token',
        'code',
        'newPassword',
        'new_password',
        'authorizationCode',
        'authorization_code',
        'refresh_token',
        '*.password',
        '*.newPassword',
        '*.new_password',
        '*.code',
        '*.code_hash',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.refresh_token',
        '*.apple_refresh_token',
        '*.authorizationCode',
        '*.authorization_code',
        '*.identityToken',
        '*.idToken',
        '*.identity_token',
        '*.id_token',
        '*.nonce',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type { Logger };
