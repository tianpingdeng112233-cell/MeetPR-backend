import { createHmac } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { sendCoachEnquiryEmail } from '../services/mail';
import { CoachPageError, PAGE_NOT_FOUND, visiblePages } from './coach-pages';

export interface EnquiryInput {
  name: string;
  contact: string;
  goal?: string | undefined;
  squat_kg?: number | null | undefined;
  bench_kg?: number | null | undefined;
  deadlift_kg?: number | null | undefined;
}
export async function createCoachEnquiry(
  db: Kysely<Database>,
  slug: string,
  sourceIp: string,
  input: EnquiryInput,
  config: Config,
) {
  return db.transaction().execute(async (trx) => {
    // Lock the page AND subscription row: quotas and visibility stay atomic across instances.
    const page = await visiblePages(trx).where('cp.slug', '=', slug).forUpdate().executeTakeFirst();
    if (!page) throw new CoachPageError(404, PAGE_NOT_FOUND);
    const now = new Date();
    // Natural expiry can happen while this query is waiting for its row locks.
    if (!page.subscription_expires_at || page.subscription_expires_at.getTime() <= now.getTime()) {
      throw new CoachPageError(404, PAGE_NOT_FOUND);
    }
    const sourceHash = createHmac('sha256', config.JWT_ACCESS_SECRET)
      .update(`coach-enquiry-source:${sourceIp}`)
      .digest('hex');
    const recent = await trx
      .selectFrom('coach_enquiries')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('coach_id', '=', page.coach_id)
      .where('source_hash', '=', sourceHash)
      .where('created_at', '>', new Date(now.getTime() - 24 * 60 * 60 * 1000))
      .executeTakeFirstOrThrow();
    if (Number(recent.count) >= 3) throw new CoachPageError(429, 'rate_limited');
    await trx
      .insertInto('coach_enquiries')
      .values({
        coach_id: page.coach_id,
        name: input.name,
        contact: input.contact,
        goal: input.goal ?? '',
        squat_kg: input.squat_kg ?? null,
        bench_kg: input.bench_kg ?? null,
        deadlift_kg: input.deadlift_kg ?? null,
        source_hash: sourceHash,
        created_at: now,
      })
      .execute();
    return page.coach_id;
  });
}
export async function notifyCoachEnquiry(
  db: Kysely<Database>,
  coachId: string,
  config: Config,
  logger: Logger,
) {
  try {
    const coach = await db
      .selectFrom('users')
      .select('email')
      .where('id', '=', coachId)
      .executeTakeFirst();
    if (!coach?.email || !config.RESEND_API_KEY || !config.EMAIL_FROM) {
      logger.info(
        { coachId, reason: !coach?.email ? 'no_email' : 'not_configured' },
        'coach_enquiry_mail_skipped',
      );
      return;
    }
    await sendCoachEnquiryEmail({
      apiKey: config.RESEND_API_KEY,
      from: config.EMAIL_FROM,
      to: coach.email,
      locale: config.MAIL_LOCALE ?? 'en',
      webUrl: config.PUBLIC_BASE_URL,
    });
  } catch {
    // The accepted enquiry is durable already. Never log the recipient or transport credentials.
    logger.warn({ coachId }, 'coach_enquiry_mail_failed');
  }
}
const enquiryFields = [
  'id',
  'name',
  'contact',
  'squat_kg',
  'bench_kg',
  'deadlift_kg',
  'goal',
  'status',
  'created_at',
] as const;
export async function listCoachEnquiries(db: Kysely<Database>, coachId: string) {
  return db
    .selectFrom('coach_enquiries')
    .select(enquiryFields)
    .where('coach_id', '=', coachId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}
export async function updateCoachEnquiry(
  db: Kysely<Database>,
  coachId: string,
  id: string,
  status: 'new' | 'contacted' | 'closed',
) {
  const row = await db
    .updateTable('coach_enquiries')
    .set({ status })
    .where('id', '=', id)
    .where('coach_id', '=', coachId)
    .returning(enquiryFields)
    .executeTakeFirst();
  if (!row) throw new CoachPageError(404, 'COACH_ENQUIRY_NOT_FOUND');
  return row;
}
