import { randomBytes } from 'node:crypto';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types';
import { generateInviteCode } from '../handlers/invite-codes';
import { codeHash } from '../routes/auth/email-code';
import type { CoachApplicationDeps } from '../routes/coach-applications';
import { sendCoachRejectionEmail, sendCoachWelcomeEmail } from './mail';

export const COACH_SETUP_PENDING_HASH = '!coach-setup-pending';

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export async function issueCoachSetup(trx: Transaction<Database>, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await trx
    .updateTable('password_reset_codes')
    .set({ used_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .where('purpose', '=', 'coach_setup')
    .where('used_at', 'is', null)
    .execute();
  await trx
    .insertInto('password_reset_codes')
    .values({
      user_id: userId,
      code_hash: codeHash(token),
      purpose: 'coach_setup',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .execute();
  return token;
}
export async function deliverCoachWelcome(
  deps: CoachApplicationDeps,
  email: string,
  token: string,
  userId: string,
): Promise<boolean> {
  const url = new URL('/coach/set-password', deps.config.COACH_ONBOARDING_URL);
  // Fragments never travel in the browser HTTP request or access logs.
  url.hash = new URLSearchParams({ email, token }).toString();
  try {
    await sendCoachWelcomeEmail({
      ...coachMailInput(deps, email),
      url: url.toString(),
    });
    return true;
  } catch {
    deps.logger.error({ userId }, 'coach_welcome_email_failed');
    return false;
  }
}
export async function approveApplication(deps: CoachApplicationDeps, id: string, adminId: string) {
  const result = await deps.db.transaction().execute(async (trx) => {
    const application = await trx
      .selectFrom('coach_applications')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!application) throw new ApplicationError('COACH_APPLICATION_NOT_FOUND', 404);
    if (application.status !== 'pending') throw new ApplicationError('COACH_APPLICATION_REVIEWED');
    const accounts = await trx
      .selectFrom('users')
      .select(['id', 'role'])
      .where(sql<string>`lower(email)`, '=', application.email)
      .execute();
    const identities = await trx
      .selectFrom('user_identities as i')
      .innerJoin('users as u', 'u.id', 'i.user_id')
      .select(['u.id', 'u.role'])
      .where('i.provider', '=', 'email')
      .where(sql<string>`lower(i.provider_uid)`, '=', application.email)
      .execute();
    const existing = [...accounts, ...identities];
    if (
      existing.some((user) => user.role === 'coached_student' || user.role === 'self_train_student')
    )
      throw new ApplicationError('COACH_APPLICATION_EMAIL_IS_STUDENT');
    if (existing.length) throw new ApplicationError('COACH_APPLICATION_EMAIL_EXISTS');
    const user = await trx
      .insertInto('users')
      .values({
        email: application.email,
        phone: null,
        password_hash: COACH_SETUP_PENDING_HASH,
        role: 'coach',
        timezone: 'Asia/Shanghai',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('user_identities')
      .values({
        user_id: user.id,
        provider: 'email',
        provider_uid: application.email,
        email_at_provider: application.email,
      })
      .execute();
    await trx
      .insertInto('coach_profiles')
      .values({ user_id: user.id, display_name: application.name })
      .execute();
    // ON CONFLICT avoids poisoning the transaction on the vanishingly rare code collision.
    let codeCreated = false;
    for (let attempt = 0; attempt < 3 && !codeCreated; attempt++) {
      const code = await trx
        .insertInto('invite_codes')
        .values({
          coach_id: user.id,
          code: generateInviteCode(),
          type: 'personal_permanent',
          max_uses: null,
          expires_at: null,
        })
        .onConflict((oc) => oc.column('code').doNothing())
        .returning('id')
        .executeTakeFirst();
      codeCreated = !!code;
    }
    if (!codeCreated) throw new Error('COACH_INVITE_CODE_EXHAUSTED');
    const token = await issueCoachSetup(trx, user.id);
    await trx
      .updateTable('coach_applications')
      .set({
        status: 'approved',
        user_id: user.id,
        reviewed_by: adminId,
        reviewed_at: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .execute();
    return { email: application.email, userId: user.id, token };
  });
  // Network delivery cannot participate in a database transaction. Keep the
  // committed account and return delivery status so the admin can resend.
  const sent = await deliverCoachWelcome(deps, result.email, result.token, result.userId);
  return { id, status: 'approved', user_id: result.userId, welcome_email_sent: sent };
}

export async function deliverCoachRejection(
  deps: CoachApplicationDeps,
  email: string,
  applicationId: string,
): Promise<boolean> {
  try {
    await sendCoachRejectionEmail({
      ...coachMailInput(deps, email),
    });
    return true;
  } catch {
    deps.logger.error({ applicationId }, 'coach_rejection_email_failed');
    return false;
  }
}

export function coachMailInput(deps: CoachApplicationDeps, email: string) {
  const { RESEND_API_KEY: apiKey, EMAIL_FROM: from } = deps.config;
  if (!apiKey || !from) throw new Error('COACH_MAIL_NOT_CONFIGURED');
  return { apiKey, from, to: email };
}
