import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { Database } from './types';

type DbExecutor = Kysely<Database> | Transaction<Database>;

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
