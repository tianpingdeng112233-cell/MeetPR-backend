import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

import { isApiError } from '../utils/apiError';

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (isApiError(err)) {
      if (!res.headersSent) res.status(err.status).json({ error: err.code });
      return;
    }

    logger.error({ err, reqId: req.id, path: req.path }, 'unhandled_error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', requestId: req.id });
  };
}
