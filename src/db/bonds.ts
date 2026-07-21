import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { Database } from './types';

type DbExecutor = Kysely<Database> | Transaction<Database>;

export interface CanonicalAcceptedBond {
  id: string;
  coach_id: string;
  student_id: string;
}

/**
 * Deterministically resolves the student's active accepted bond while legacy
 * data may still contain more than one accepted coach (chat spec 024 D6).
 */
export async function resolveCanonicalAcceptedBond(
  db: DbExecutor,
  studentId: string,
): Promise<CanonicalAcceptedBond | undefined> {
  return db
    .selectFrom('bind_requests')
    .select(['id', 'coach_id', 'student_id'])
    .where('student_id', '=', studentId)
    .where('status', '=', 'accepted')
    .orderBy(sql`responded_at DESC NULLS LAST`)
    .orderBy('submitted_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

/** True when (coach, student) share an accepted bind_requests bond. */
export async function hasAcceptedBond(
  db: DbExecutor,
  coachId: string,
  studentId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('bind_requests')
    .select(sql<number>`1`.as('exists'))
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .where('status', '=', 'accepted')
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * True when the coach may read the student's onboarding profile: accepted bond
 * OR a live (not yet expired) pending bind request — the receive-queue
 * "view full profile" path (spec 005 D16). Read-only check: does not flip
 * stale pendings to expired.
 */
export async function hasOnboardingReadAccess(
  db: DbExecutor,
  coachId: string,
  studentId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('bind_requests')
    .select(sql<number>`1`.as('exists'))
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'accepted'),
        eb.and([eb('status', '=', 'pending'), eb('expired_at', '>', sql<Date>`now()`)]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}
