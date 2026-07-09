import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';
import { timestamp } from './serialization';

export interface SetLogInput {
  plan_exercise_id: string;
  exercise_id: string;
  logged_date: string;
  /**
   * True only when the client sent logged_date explicitly. Old builds omit it
   * (the server fills today); their conflict updates must not drag a
   * historical set's logged_date to the server's current day.
   */
  update_logged_date: boolean;
  set_index: number;
  weight_kg: string;
  reps: number;
  rpe: string | null;
  completed: boolean;
  failed: boolean;
}

export interface AdhocSetLogInput {
  exercise_id: string;
  logged_date: string;
  set_index: number;
  weight_kg: string;
  reps: number;
  rpe: string | null;
  completed: boolean;
  failed: boolean;
}

export interface SetLogResult {
  id: string;
  logged_at: string;
}

function defaultFailed(value: boolean | undefined): boolean {
  return value ?? false;
}

/**
 * Resolve a plan exercise the student is allowed to log against (published
 * plan they own) and surface its exercise identity for the insert. Replaces
 * the boolean canLogSet (spec 010).
 */
export async function resolvePlanExercise(
  db: Kysely<Database>,
  planExerciseId: string,
  studentId: string,
): Promise<{ exerciseId: string } | null> {
  const row = await db
    .selectFrom('plan_exercises as pe')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select('pe.exercise_id as exercise_id')
    .where('pe.id', '=', planExerciseId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', '=', 'published')
    .limit(1)
    .executeTakeFirst();

  return row === undefined ? null : { exerciseId: row.exercise_id };
}

export async function exerciseExists(db: Kysely<Database>, exerciseId: string): Promise<boolean> {
  const row = await db
    .selectFrom('exercises')
    .select(sql<number>`1`.as('exists'))
    .where('id', '=', exerciseId)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

export async function upsertSetLog(
  db: Kysely<Database>,
  studentId: string,
  input: SetLogInput,
): Promise<SetLogResult> {
  const failed = defaultFailed(input.failed);

  const row = await db
    .insertInto('set_logs')
    .values({
      student_id: studentId,
      plan_exercise_id: input.plan_exercise_id,
      exercise_id: input.exercise_id,
      logged_date: input.logged_date,
      set_index: input.set_index,
      weight_kg: input.weight_kg,
      reps: input.reps,
      rpe: input.rpe,
      completed: input.completed,
      failed,
      assumed: false,
    })
    .onConflict((oc) =>
      input.update_logged_date
        ? oc.columns(['student_id', 'plan_exercise_id', 'set_index']).doUpdateSet({
            weight_kg: (eb) => eb.ref('excluded.weight_kg'),
            reps: (eb) => eb.ref('excluded.reps'),
            rpe: (eb) => eb.ref('excluded.rpe'),
            completed: (eb) => eb.ref('excluded.completed'),
            failed: (eb) => eb.ref('excluded.failed'),
            assumed: false,
            logged_date: (eb) => eb.ref('excluded.logged_date'),
            logged_at: sql<Date>`now()`,
          })
        : oc.columns(['student_id', 'plan_exercise_id', 'set_index']).doUpdateSet({
            weight_kg: (eb) => eb.ref('excluded.weight_kg'),
            reps: (eb) => eb.ref('excluded.reps'),
            rpe: (eb) => eb.ref('excluded.rpe'),
            completed: (eb) => eb.ref('excluded.completed'),
            failed: (eb) => eb.ref('excluded.failed'),
            assumed: false,
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function updateAdhocSetLog(
  db: Kysely<Database>,
  studentId: string,
  input: AdhocSetLogInput,
): Promise<SetLogResult | null> {
  const row = await db
    .updateTable('set_logs')
    .set({
      weight_kg: input.weight_kg,
      reps: input.reps,
      rpe: input.rpe,
      completed: input.completed,
      failed: input.failed,
      assumed: false,
      logged_at: sql<Date>`now()`,
    })
    .where('student_id', '=', studentId)
    .where('exercise_id', '=', input.exercise_id)
    .where('logged_date', '=', input.logged_date)
    .where('set_index', '=', input.set_index)
    .where('adhoc', '=', true)
    .returning(['id', 'logged_at'])
    .executeTakeFirst();

  return row === undefined ? null : { id: row.id, logged_at: timestamp(row.logged_at) };
}

/**
 * Idempotent upsert keyed on (student, exercise, logged_date, set_index)
 * for rows born outside any plan. Update-then-insert as three independent
 * statements — deliberately NOT one transaction: ON CONFLICT cannot target
 * the partial unique index in the pg-mem harness, and catching a unique
 * violation inside a Postgres transaction would leave it aborted for the
 * retry. Each statement is atomic on its own; the partial index from
 * db/migrations/0031 backstops the race, and a losing insert (23505) falls
 * back to the update path.
 */
export async function upsertAdhocSetLog(
  db: Kysely<Database>,
  studentId: string,
  input: AdhocSetLogInput,
): Promise<SetLogResult> {
  const updated = await updateAdhocSetLog(db, studentId, input);
  if (updated !== null) {
    return updated;
  }

  try {
    const row = await db
      .insertInto('set_logs')
      .values({
        student_id: studentId,
        plan_exercise_id: null,
        exercise_id: input.exercise_id,
        logged_date: input.logged_date,
        adhoc: true,
        set_index: input.set_index,
        weight_kg: input.weight_kg,
        reps: input.reps,
        rpe: input.rpe,
        completed: input.completed,
        failed: input.failed,
        assumed: false,
      })
      .returning(['id', 'logged_at'])
      .executeTakeFirstOrThrow();

    return { id: row.id, logged_at: timestamp(row.logged_at) };
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const raced = await updateAdhocSetLog(db, studentId, input);
    if (raced === null) {
      throw error;
    }
    return raced;
  }
}
