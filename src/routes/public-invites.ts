import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import { findValidInvite } from '../handlers/public-invites';
import { route } from './http';
export function publicInvitesRouter(db: Kysely<Database>) {
  const router = Router();
  router.get(
    '/:code',
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
    route(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const code = req.params.code?.trim().toUpperCase() ?? '';
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)) {
        res.json({ valid: false, coach_display_name: null });
        return;
      }
      const invite = await findValidInvite(db, code);
      res.json({ valid: !!invite, coach_display_name: invite?.display_name ?? null });
    }),
  );
  return router;
}
