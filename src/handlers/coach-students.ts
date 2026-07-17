import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { normalizeDateOnly } from '../utils/date';
import { fetchRecentFourWeekActivity, type RecentWeekActivity } from './recent-training';
import { timestamp } from './serialization';

export interface CoachStudentEvaluation {
  id: string;
  expected_end_at: string;
  overdue: boolean;
}

export interface CoachStudentSummary {
  id: string;
  display_name: string;
  profile: {
    user_id: string;
    display_name: string;
    created_at: string;
  };
  // 'in_evaluation' while the pair has an uncompleted evaluation period;
  // iOS derives the remaining-time badge from evaluation.expected_end_at.
  status: 'active' | 'in_evaluation';
  evaluation: CoachStudentEvaluation | null;
  competition_date: string | null;
  recent_4w: RecentWeekActivity[];
}

export async function listCoachStudents(
  db: Kysely<Database>,
  coachId: string,
  now: Date = new Date(),
): Promise<CoachStudentSummary[]> {
  // student_profiles is LEFT-joined: nothing at the DB level guarantees an
  // accepted bond has a profile row (only the bind-request flow bootstraps
  // one), and an INNER JOIN would silently drop such students from the roster.
  const rows = await db
    .selectFrom('bind_requests as br')
    .innerJoin('users as u', 'u.id', 'br.student_id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .leftJoin('student_onboarding_profiles as sop', 'sop.user_id', 'u.id')
    .leftJoin('evaluation_periods as ep', (join) =>
      join
        .onRef('ep.student_id', '=', 'br.student_id')
        .on('ep.coach_id', '=', coachId)
        .on('ep.completed_at', 'is', null),
    )
    .select([
      'u.id as id',
      'u.created_at as user_created_at',
      'sp.display_name as display_name',
      'sp.created_at as profile_created_at',
      'sop.competition_date as competition_date',
      'ep.id as evaluation_id',
      'ep.expected_end_at as evaluation_expected_end_at',
    ])
    .where('br.coach_id', '=', coachId)
    .where('br.status', '=', 'accepted')
    .orderBy('u.created_at', 'desc')
    .execute();
  const recentByStudent = await fetchRecentFourWeekActivity(
    db,
    coachId,
    rows.map((row) => row.id),
    now,
  );

  return rows.map((row) => {
    // Read-time derived flag, same rule as toEvaluationPeriod (spec 005 D7):
    // past expected_end_at stays in progress, marked overdue.
    const evaluation: CoachStudentEvaluation | null =
      row.evaluation_id !== null && row.evaluation_expected_end_at !== null
        ? {
            id: row.evaluation_id,
            expected_end_at: timestamp(row.evaluation_expected_end_at),
            overdue: new Date(row.evaluation_expected_end_at) < now,
          }
        : null;
    // Profile-less fallback mirrors the signals API ruling (spec 018 card 5):
    // empty display_name, keep the profile envelope non-null for live clients.
    const displayName = row.display_name ?? '';
    return {
      id: row.id,
      display_name: displayName,
      profile: {
        user_id: row.id,
        display_name: displayName,
        created_at: timestamp(row.profile_created_at ?? row.user_created_at),
      },
      status: evaluation === null ? ('active' as const) : ('in_evaluation' as const),
      evaluation,
      competition_date:
        row.competition_date === null ? null : normalizeDateOnly(row.competition_date),
      recent_4w: recentByStudent.get(row.id) ?? [
        { trained_days: 0, planned_days: 0 },
        { trained_days: 0, planned_days: 0 },
        { trained_days: 0, planned_days: 0 },
        { trained_days: 0, planned_days: 0 },
      ],
    };
  });
}

/** Rename a student only when the caller currently has an accepted bond.
 * Returning null for unknown and unbound students alike avoids leaking roster
 * membership through this write endpoint. */
export async function renameCoachStudent(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  displayName: string,
): Promise<CoachStudentSummary | null> {
  const bond = await db
    .selectFrom('bind_requests')
    .select('id')
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .where('status', '=', 'accepted')
    .executeTakeFirst();
  if (!bond) return null;

  // Upsert instead of update: a bonded student may lack a profile row (the
  // roster LEFT-joins it), and renaming is exactly how a coach repairs that.
  await db
    .insertInto('student_profiles')
    .values({ user_id: studentId, display_name: displayName })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ display_name: displayName, updated_at: new Date() }),
    )
    .execute();

  const students = await listCoachStudents(db, coachId);
  return students.find((student) => student.id === studentId) ?? null;
}
