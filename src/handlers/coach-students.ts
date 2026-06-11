import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
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
}

export async function listCoachStudents(
  db: Kysely<Database>,
  coachId: string,
): Promise<CoachStudentSummary[]> {
  const rows = await db
    .selectFrom('bind_requests as br')
    .innerJoin('users as u', 'u.id', 'br.student_id')
    .innerJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .leftJoin('evaluation_periods as ep', (join) =>
      join
        .onRef('ep.student_id', '=', 'br.student_id')
        .on('ep.coach_id', '=', coachId)
        .on('ep.completed_at', 'is', null),
    )
    .select([
      'u.id as id',
      'sp.display_name as display_name',
      'sp.user_id as profile_user_id',
      'sp.created_at as profile_created_at',
      'ep.id as evaluation_id',
      'ep.expected_end_at as evaluation_expected_end_at',
    ])
    .where('br.coach_id', '=', coachId)
    .where('br.status', '=', 'accepted')
    .orderBy('u.created_at', 'desc')
    .execute();

  return rows.map((row) => {
    // Read-time derived flag, same rule as toEvaluationPeriod (spec 005 D7):
    // past expected_end_at stays in progress, marked overdue.
    const evaluation: CoachStudentEvaluation | null =
      row.evaluation_id !== null && row.evaluation_expected_end_at !== null
        ? {
            id: row.evaluation_id,
            expected_end_at: timestamp(row.evaluation_expected_end_at),
            overdue: new Date(row.evaluation_expected_end_at) < new Date(),
          }
        : null;
    return {
      id: row.id,
      display_name: row.display_name,
      profile: {
        user_id: row.profile_user_id,
        display_name: row.display_name,
        created_at: timestamp(row.profile_created_at),
      },
      status: evaluation === null ? ('active' as const) : ('in_evaluation' as const),
      evaluation,
    };
  });
}
