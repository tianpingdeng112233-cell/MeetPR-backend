import type { Request, RequestHandler, Response } from 'express';
import type { ZodError } from 'zod';

export function validationEnvelope(error: ZodError) {
  return {
    error: 'VALIDATION_ERROR',
    issues: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  };
}

export function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}
