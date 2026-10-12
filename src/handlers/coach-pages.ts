import { coachSiteBaseUrl, type Config } from '../config';
import { fetchCoachPageStats } from './coach-page-stats';
import { publicVerifiedStats } from '../domain/coach-page-stats';
import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { CoachPagesTable, CoachPageStatus, Database } from '../db/types';

export class CoachPageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly missing?: string[],
  ) {
    super(code);
  }
}
export const PAGE_NOT_FOUND = 'COACH_PAGE_NOT_FOUND';

export async function ensureCoachPage(db: Kysely<Database>, coachId: string) {
  await db
    .insertInto('coach_pages')
    .values({ coach_id: coachId })
    .onConflict((oc) => oc.column('coach_id').doNothing())
    .execute();
  return db
    .selectFrom('coach_pages')
    .selectAll()
    .where('coach_id', '=', coachId)
    .executeTakeFirstOrThrow();
}

export function visiblePages(db: Kysely<Database>, now = new Date()) {
  return db
    .selectFrom('coach_pages as cp')
    .innerJoin('coach_profiles as profile', 'profile.user_id', 'cp.coach_id')
    .selectAll('cp')
    .select(['profile.display_name', 'profile.subscription_expires_at'])
    .where('cp.status', '=', 'published')
    .where('profile.subscription_expires_at', '>', now);
}
export async function publicPage(db: Kysely<Database>, slug: string) {
  const page = await visiblePages(db).where('cp.slug', '=', slug).executeTakeFirst();
  if (!page) throw new CoachPageError(404, PAGE_NOT_FOUND);
  return page;
}
export function selfDescription(page: Selectable<CoachPagesTable> & { display_name: string }) {
  return {
    slug: page.slug,
    display_name: page.display_name,
    avatar_url: null,
    headline: page.headline,
    bio: page.bio,
    specialties: page.specialties,
  };
}
export async function pagePreview(
  db: Kysely<Database>,
  coachId: string,
  config: Pick<Config, 'COACH_SITE_BASE_URL'>,
  admin = false,
) {
  const page = await ensureCoachPage(db, coachId);
  const profile = await db
    .selectFrom('coach_profiles')
    .select(['display_name', 'subscription_expires_at'])
    .where('user_id', '=', coachId)
    .executeTakeFirst();
  const expiry = profile?.subscription_expires_at ?? null;
  const now = new Date();
  const stats = await fetchCoachPageStats(db, coachId, now);
  return {
    ...page,
    verified_stats: admin ? stats : publicVerifiedStats(stats),
    data_as_of: now.toISOString(),
    display_name: profile?.display_name ?? '',
    avatar_url: null,
    subscription_expires_at: expiry,
    subscription_expired: expiry === null || expiry.getTime() <= Date.now(),
    public_url: page.slug ? `${coachSiteBaseUrl(config)}/c/${page.slug}` : null,
  };
}
export interface PageEdit {
  slug?: string | undefined;
  headline?: string | undefined;
  bio?: string | undefined;
  specialties?: string[] | undefined;
}
export async function editCoachPage(
  db: Kysely<Database>,
  coachId: string,
  edit: PageEdit,
  admin = false,
) {
  await ensureCoachPage(db, coachId);
  try {
    await db.transaction().execute(async (trx) => {
      const page = await trx
        .selectFrom('coach_pages')
        .selectAll()
        .where('coach_id', '=', coachId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (page.status !== 'draft' && edit.headline?.trim() === '') {
        throw new CoachPageError(409, 'COACH_PAGE_HEADLINE_REQUIRED');
      }
      if (!admin && page.listed_at && edit.slug !== undefined && edit.slug !== page.slug)
        throw new CoachPageError(409, 'COACH_PAGE_SLUG_LOCKED');
      const changed =
        (edit.headline !== undefined && edit.headline !== page.headline) ||
        (edit.bio !== undefined && edit.bio !== page.bio) ||
        (edit.specialties !== undefined &&
          JSON.stringify(edit.specialties) !== JSON.stringify(page.specialties));
      await trx
        .updateTable('coach_pages')
        .set({
          ...edit,
          updated_at: new Date(),
          changes_pending_review:
            page.changes_pending_review || (page.status === 'published' && changed),
        })
        .where('coach_id', '=', coachId)
        .execute();
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new CoachPageError(409, 'COACH_PAGE_SLUG_TAKEN');
    throw error;
  }
}
export type PageAction =
  | 'submit'
  | 'hide'
  | 'show'
  | 'approve'
  | 'reject'
  | 'suspend'
  | 'restore'
  | 'mark-reviewed';
export async function transitionPage(
  db: Kysely<Database>,
  coachId: string,
  action: PageAction,
  reason?: string,
) {
  await ensureCoachPage(db, coachId);
  await db.transaction().execute(async (trx) => {
    const page = await trx
      .selectFrom('coach_pages')
      .selectAll()
      .where('coach_id', '=', coachId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const allowed: Record<PageAction, CoachPageStatus[]> = {
      submit: ['draft'],
      hide: ['published'],
      show: ['hidden'],
      approve: ['pending'],
      reject: ['pending'],
      suspend: ['published', 'hidden'],
      restore: ['suspended'],
      'mark-reviewed': ['draft', 'pending', 'published', 'hidden', 'suspended'],
    };
    if (
      !allowed[action].includes(page.status) ||
      (['show', 'restore'].includes(action) && !page.listed_at)
    )
      throw new CoachPageError(409, 'COACH_PAGE_INVALID_STATE');
    if (action === 'submit') {
      const profile = await trx
        .selectFrom('coach_profiles')
        .select('subscription_expires_at')
        .where('user_id', '=', coachId)
        .executeTakeFirst();
      const missing = [
        !page.slug && 'slug',
        !page.headline.trim() && 'headline',
        (!profile?.subscription_expires_at ||
          profile.subscription_expires_at.getTime() <= Date.now()) &&
          'subscription',
      ].filter((x): x is string => !!x);
      if (missing.length) throw new CoachPageError(409, 'COACH_PAGE_SUBMIT_REQUIREMENTS', missing);
    }
    const targets: Record<PageAction, CoachPageStatus> = {
      submit: 'pending',
      hide: 'hidden',
      show: 'published',
      approve: 'published',
      reject: 'draft',
      suspend: 'suspended',
      restore: 'published',
      'mark-reviewed': page.status,
    };
    await trx
      .updateTable('coach_pages')
      .set({
        status: targets[action],
        updated_at: new Date(),
        ...(action === 'approve'
          ? { listed_at: page.listed_at ?? new Date(), rejection_reason: null }
          : {}),
        ...(action === 'reject' ? { rejection_reason: reason ?? null } : {}),
        ...(action === 'submit' ? { rejection_reason: null } : {}),
        ...(['approve', 'mark-reviewed'].includes(action) ? { changes_pending_review: false } : {}),
      })
      .where('coach_id', '=', coachId)
      .execute();
  });
}
export async function requireCoach(db: Kysely<Database>, coachId: string) {
  const coach = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', coachId)
    .where('role', '=', 'coach')
    .executeTakeFirst();
  if (!coach) throw new CoachPageError(404, PAGE_NOT_FOUND);
}
export async function setSubscription(db: Kysely<Database>, coachId: string, expires: Date | null) {
  await requireCoach(db, coachId);
  await db
    .insertInto('coach_profiles')
    .values({ user_id: coachId, display_name: '', subscription_expires_at: expires })
    .onConflict((oc) =>
      oc
        .column('user_id')
        .doUpdateSet({ subscription_expires_at: expires, updated_at: sql`now()` }),
    )
    .execute();
}
