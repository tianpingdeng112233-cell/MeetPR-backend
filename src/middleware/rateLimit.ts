import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

import type { Config } from '../config';

export function createGlobalRateLimit(
  config: Pick<Config, 'RATE_LIMIT_WINDOW_MS' | 'RATE_LIMIT_MAX'>,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  });
}
