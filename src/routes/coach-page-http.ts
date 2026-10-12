import type { Request, Response } from 'express';
import { z } from 'zod';
import { CoachPageError } from '../handlers/coach-pages';
import { route } from './http';

const reserved = new Set([
  'admin',
  'api',
  'c',
  'coaches',
  'privacy',
  'www',
  'app',
  'meetpr',
  'login',
]);
export const slugSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/)
  .refine((s) => !reserved.has(s));
export const pageEditSchema = z
  .object({
    slug: slugSchema.optional(),
    headline: z.string().trim().max(30).optional(),
    bio: z.string().trim().max(500).optional(),
    specialties: z.array(z.string().trim().min(1).max(10)).max(5).optional(),
  })
  .strict();
export function pageRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return route(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!(error instanceof CoachPageError)) throw error;
      res
        .status(error.status)
        .json({ error: error.code, ...(error.missing ? { missing: error.missing } : {}) });
    }
  });
}

export function pageUserId(req: Request): string {
  if (!req.user) throw new CoachPageError(401, 'AUTH_INVALID_TOKEN');
  return req.user.id;
}
