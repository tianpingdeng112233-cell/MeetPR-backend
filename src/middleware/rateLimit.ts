import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';

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
    // /events* carries its own dedicated, fail-open limiter keyed on anon_id.
    // Behind the Aliyun SLB every user shares one source IP, so letting analytics
    // count against the per-IP global bucket would let an analytics retry storm
    // 429 the real app (and eat the /auth + /sets quota). Exempt the whole
    // analytics surface (ingest + feedback + config read) from the global limiter.
    skip: (req) => req.path === '/events' || req.path.startsWith('/events/'),
  });
}

/**
 * Dedicated limiter for POST /events and POST /events/feedback. Keyed on anon_id
 * (present pre-login too, lifted to the batch top level so it reads reliably),
 * falling back to the authenticated user then IP. Fail-OPEN: over-limit silently
 * drops with 204 — analytics must NEVER surface as a 429 in the real app
 * (SPEC §3.7). Mount after express.json so req.body.anon_id is populated.
 */
export function createEventsRateLimit(
  config: Pick<Config, 'EVENTS_RATE_LIMIT_WINDOW_MS' | 'EVENTS_RATE_LIMIT_MAX'>,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.EVENTS_RATE_LIMIT_WINDOW_MS,
    limit: config.EVENTS_RATE_LIMIT_MAX,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const anon = (req.body as { anon_id?: unknown } | undefined)?.anon_id;
      if (typeof anon === 'string' && anon.length > 0) return anon;
      if (req.user?.id) return req.user.id;
      return req.ip ?? 'unknown';
    },
    handler: (_req, res) => {
      res.status(204).end();
    },
    // anon_id is the real key; the IP fallback is incidental, so skip the
    // library's default-keyGenerator IP validation.
    validate: { ip: false },
  });
}

const EMAIL_AUTH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function emailKey(req: Request): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : 'invalid-email';
}

function silentNoContent(_req: Request, res: Response): void {
  res.status(204).end();
}

export function createForgotEmailRateLimit(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: EMAIL_AUTH_RATE_LIMIT_WINDOW_MS,
    limit: 3,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: emailKey,
    handler: silentNoContent,
    validate: { ip: false },
  });
}

export function createForgotIpRateLimit(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: EMAIL_AUTH_RATE_LIMIT_WINDOW_MS,
    limit: 10,
    standardHeaders: false,
    legacyHeaders: false,
    handler: silentNoContent,
  });
}

export function createResetEmailRateLimit(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: EMAIL_AUTH_RATE_LIMIT_WINDOW_MS,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
    keyGenerator: emailKey,
    validate: { ip: false },
  });
}
