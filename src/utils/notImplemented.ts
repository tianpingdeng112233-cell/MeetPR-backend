import type { Response } from 'express';

export function notImplemented(res: Response, endpoint: string): Response {
  return res.status(501).json({ error: 'not_implemented', endpoint });
}
