import express, { type ErrorRequestHandler } from 'express';

/** The 400k character limit includes multibyte text and sparse-cell envelopes. */
export function planImportJson() {
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const tooLarge =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large';
    // SyntaxError from body-parser carries its original body. Never forward it
    // to the global logger, even on malformed/oversized requests.
    res
      .status(tooLarge ? 413 : 400)
      .json({ error: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR' });
  };
  return [express.json({ limit: '32mb' }), errors];
}
