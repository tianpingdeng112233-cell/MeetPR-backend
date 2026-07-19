import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';

export async function getCoachExerciseUsage(db: Kysely<Database>, coachId: string) {
  const rows = await db
    .selectFrom('plan_exercises as pe')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select(['pe.exercise_id as exercise_id', sql<string>`count(*)`.as('plan_count')])
    .where('p.coach_id', '=', coachId)
    .groupBy('pe.exercise_id')
    .orderBy('plan_count', 'desc')
    .execute();

  return {
    stats: rows.map((row) => ({
      exercise_id: row.exercise_id,
      plan_count: Number(row.plan_count),
    })),
  };
}
