import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/types';
import type { ExerciseRefV1 } from '../domain/exercise-ref';

/** JSON references are frozen snapshots; only their optional plan pointers need ownership checks. */
export async function ownsExerciseRef(
  db: Kysely<Database> | Transaction<Database>,
  studentId: string,
  ref: ExerciseRefV1,
): Promise<boolean> {
  if (ref.plan_day_id !== null) {
    const day = await db
      .selectFrom('plan_days as pd')
      .innerJoin('plans as p', 'p.id', 'pd.plan_id')
      .select('pd.id')
      .where('pd.id', '=', ref.plan_day_id)
      .where('p.trainee_id', '=', studentId)
      .executeTakeFirst();
    if (!day) return false;
  }
  if (ref.plan_exercise_id !== null) {
    const exercise = await db
      .selectFrom('plan_exercises as pe')
      .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
      .innerJoin('plans as p', 'p.id', 'pd.plan_id')
      .select('pe.id')
      .where('pe.id', '=', ref.plan_exercise_id)
      .where('p.trainee_id', '=', studentId)
      .executeTakeFirst();
    if (!exercise) return false;
  }
  return true;
}
