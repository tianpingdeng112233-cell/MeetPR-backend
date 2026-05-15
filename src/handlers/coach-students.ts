import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { timestamp } from './serialization';

export interface CoachStudentSummary {
  id: string;
  display_name: string;
  profile: {
    user_id: string;
    display_name: string;
    created_at: string;
  };
  status: 'active';
}

export async function listCoachStudents(
  db: Kysely<Database>,
  coachId: string,
): Promise<CoachStudentSummary[]> {
  const rows = await db
    .selectFrom('bind_requests as br')
    .innerJoin('users as u', 'u.id', 'br.student_id')
    .innerJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .select([
      'u.id as id',
      'sp.display_name as display_name',
      'sp.user_id as profile_user_id',
      'sp.created_at as profile_created_at',
    ])
    .where('br.coach_id', '=', coachId)
    .where('br.status', '=', 'accepted')
    .orderBy('u.created_at', 'desc')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    display_name: row.display_name,
    profile: {
      user_id: row.profile_user_id,
      display_name: row.display_name,
      created_at: timestamp(row.profile_created_at),
    },
    status: 'active',
  }));
}
