import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { Config } from '../../config';
import type { Database } from '../../db/types';
import { sendOtp } from '../sms';
import { route } from '../../routes/http';
import type { CoachReviewAccountsTable } from './types';
export interface CoachReviewDeps {
  db: Kysely<Database>;
  config: Config;
  sendOtp?: typeof sendOtp;
}
export const Phone = z
  .string()
  .regex(/^(?:\+86)?1\d{10}$/u)
  .transform((v) => v.replace(/^\+86/u, ''));
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const codeHash = (config: Config, phone: string, code: string) =>
  createHmac('sha256', config.JWT_REFRESH_SECRET)
    .update(`coach-review-otp:${phone}:${code}`)
    .digest('hex');
export async function requestCoachReviewOtp(deps: CoachReviewDeps, phone: string) {
  return deps.db.transaction().execute(async (trx) => {
    const now = new Date(Date.now());
    // Calendar-day quota uses China time, independent of the host timezone.
    const day = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await trx
      .insertInto('coach_review_otps')
      .values({ phone, day })
      .onConflict((oc) => oc.column('phone').doNothing())
      .execute();
    const row = await trx
      .selectFrom('coach_review_otps')
      .selectAll()
      .where('phone', '=', phone)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.last_sent_at && now.getTime() - new Date(row.last_sent_at).getTime() < 60_000)
      return 'OTP_COOLDOWN';
    const count = row.day === day ? row.daily_count : 0;
    if (count >= 10) return 'OTP_DAILY_LIMIT';
    // No logger passed: the shared placeholder logs phone when a logger is supplied.
    const code = await (deps.sendOtp ?? sendOtp)(phone);
    if (!/^\d{6}$/u.test(code)) throw new Error('Invalid SMS provider code');
    await trx
      .updateTable('coach_review_otps')
      .set({
        code_hash: codeHash(deps.config, phone, code),
        expires_at: new Date(now.getTime() + 300_000),
        last_sent_at: now,
        day,
        daily_count: count + 1,
        attempts: 0,
      })
      .where('phone', '=', phone)
      .execute();
    return null;
  });
}
export async function loginCoachReviewer(deps: CoachReviewDeps, phone: string, code: string) {
  return deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('coach_review_otps')
      .selectAll()
      .where('phone', '=', phone)
      .forUpdate()
      .executeTakeFirst();
    if (
      !row?.code_hash ||
      !row.expires_at ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      row.attempts >= 5
    )
      return null;
    const hash = codeHash(deps.config, phone, code);
    if (!timingSafeEqual(Buffer.from(hash), Buffer.from(row.code_hash))) {
      await trx
        .updateTable('coach_review_otps')
        .set({ attempts: row.attempts + 1 })
        .where('phone', '=', phone)
        .execute();
      return null;
    }
    await trx
      .updateTable('coach_review_otps')
      .set({ code_hash: null, expires_at: null })
      .where('phone', '=', phone)
      .execute();
    await trx
      .insertInto('coach_review_accounts')
      .values({ phone })
      .onConflict((oc) => oc.column('phone').doNothing())
      .execute();
    const account = await trx
      .selectFrom('coach_review_accounts')
      .select(['id', 'nickname'])
      .where('phone', '=', phone)
      .executeTakeFirstOrThrow();
    const token = `cr_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await trx
      .insertInto('coach_review_tokens')
      .values({ token_hash: tokenHash(token), account_id: account.id, expires_at: expiresAt })
      .execute();
    return { token, expires_at: expiresAt, account };
  });
}
export function reviewerRoute(
  deps: CoachReviewDeps,
  handler: (
    req: Request,
    res: Response,
    account: Selectable<CoachReviewAccountsTable>,
  ) => Promise<void>,
) {
  return route(async (req, res) => {
    const token = req.headers.authorization?.match(/^Bearer (cr_[\w-]{43})$/u)?.[1];
    const session = token
      ? await deps.db
          .selectFrom('coach_review_tokens')
          .select('account_id')
          .where('token_hash', '=', tokenHash(token))
          .where('expires_at', '>', new Date(Date.now()))
          .executeTakeFirst()
      : undefined;
    const account = session
      ? await deps.db
          .selectFrom('coach_review_accounts')
          .selectAll()
          .where('id', '=', session.account_id)
          .executeTakeFirst()
      : undefined;
    if (!account) {
      res.status(401).json({ error: 'COACH_REVIEW_AUTH_REQUIRED' });
      return;
    }
    await handler(req, res, account);
  });
}
