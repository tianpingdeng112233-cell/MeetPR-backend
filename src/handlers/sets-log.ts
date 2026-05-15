import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';
import { timestamp } from './serialization';

export interface SetLogInput {
  plan_exercise_id: string;
  set_index: number;
  weight_kg: string;
  reps: number;
  rpe: string | null;
  completed: boolean;
}

export interface SetLogResult {
  id: string;
  logged_at: string;
}

export async function canLogSet(
  db: Kysely<Database>,
  planExerciseId: string,
  studentId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('plan_exercises as pe')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select(sql<number>`1`.as('exists'))
    .where('pe.id', '=', planExerciseId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', '=', 'published')
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

export async function upsertSetLog(
  db: Kysely<Database>,
  studentId: string,
  input: SetLogInput,
): Promise<SetLogResult> {
  const row = await db
    .insertInto('set_logs')
    .values({
      student_id: studentId,
      plan_exercise_id: input.plan_exercise_id,
      set_index: input.set_index,
      weight_kg: input.weight_kg,
      reps: input.reps,
      rpe: input.rpe,
      completed: input.completed,
    })
    .onConflict((oc) =>
      oc.columns(['student_id', 'plan_exercise_id', 'set_index']).doUpdateSet({
        weight_kg: (eb) => eb.ref('excluded.weight_kg'),
        reps: (eb) => eb.ref('excluded.reps'),
        rpe: (eb) => eb.ref('excluded.rpe'),
        completed: (eb) => eb.ref('excluded.completed'),
        logged_at: sql<Date>`now()`,
      }),
    )
    .returning(['id', 'logged_at'])
    .executeTakeFirstOrThrow();

  return {
    id: row.id,
    logged_at: timestamp(row.logged_at),
  };
}
