import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

/**
 * body-parser (express.json) throws typed errors carrying an HTTP status:
 * a >1mb body is a PayloadTooLargeError (type 'entity.too.large', status 413).
 * We pass that 413 through instead of masking it as 500, so the analytics client
 * knows to split the batch and retry rather than wedging the queue (SPEC §3.2).
 * Everything else stays 500 — we never leak arbitrary error statuses/messages.
 */
function isPayloadTooLarge(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  return e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    logger.error({ err, reqId: req.id, path: req.path }, 'unhandled_error');
    if (res.headersSent) return;
    if (isPayloadTooLarge(err)) {
      res.status(413).json({ error: 'payload_too_large', requestId: req.id });
      return;
    }
    res.status(500).json({ error: 'internal_error', requestId: req.id });
  };
}
