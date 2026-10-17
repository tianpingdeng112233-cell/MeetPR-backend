import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types';
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
      const invite = await db
        .selectFrom('invite_codes as i')
        .innerJoin('users as u', 'u.id', 'i.coach_id')
        .leftJoin('coach_profiles as p', 'p.user_id', 'i.coach_id')
        .select('p.display_name')
        .where('i.code', '=', code)
        .where('u.role', '=', 'coach')
        .where('i.revoked_at', 'is', null)
        .where((eb) =>
          eb.or([eb('i.expires_at', 'is', null), eb('i.expires_at', '>', sql<Date>`now()`)]),
        )
        .where((eb) =>
          eb.or([eb('i.max_uses', 'is', null), eb('i.used_count', '<', eb.ref('i.max_uses'))]),
        )
        .executeTakeFirst();
      res.json({ valid: !!invite, coach_display_name: invite?.display_name ?? null });
    }),
  );
  return router;
}
