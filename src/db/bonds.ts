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
  return (await resolveCanonicalAcceptedBonds(db, [studentId]))[0];
}

/**
 * Batch form of the canonical accepted-bond resolver. Candidate ordering is
 * the exact spec 024 ordering used by the original single-student query.
 */
export async function resolveCanonicalAcceptedBonds(
  db: DbExecutor,
  studentIds: string[],
): Promise<CanonicalAcceptedBond[]> {
  if (studentIds.length === 0) return [];

  const candidates = await db
    .selectFrom('bind_requests')
    .select(['id', 'coach_id', 'student_id'])
    .where('student_id', 'in', studentIds)
    .where('status', '=', 'accepted')
    .orderBy('student_id')
    .orderBy(sql`responded_at DESC NULLS LAST`)
    .orderBy('submitted_at', 'desc')
    .orderBy('id', 'desc')
    .execute();

  const seenStudents = new Set<string>();
  return candidates.filter((candidate) => {
    if (seenStudents.has(candidate.student_id)) return false;
    seenStudents.add(candidate.student_id);
    return true;
  });
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
