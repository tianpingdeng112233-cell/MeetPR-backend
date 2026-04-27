import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    logger.error({ err, reqId: req.id, path: req.path }, 'unhandled_error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', requestId: req.id });
  };
}
