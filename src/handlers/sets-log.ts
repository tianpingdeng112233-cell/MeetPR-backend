import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';
import { uuidEquals } from '../utils/uuid';
import { timestamp } from './serialization';

export interface SetLogInput {
  is_warmup?: boolean;
  plan_id: string;
  plan_day_id: string;
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
  weight_kg: string | null;
  reps: number;
  rpe: string | null;
  actual_rir?: number | null;
  completed: boolean;
  failed: boolean;
}

export interface AdhocSetLogInput {
  plan_day_id?: string | null;
  exercise_id: string;
  logged_date: string;
  set_index: number;
  weight_kg: string | null;
  reps: number;
  rpe: string | null;
  actual_rir?: number | null;
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
): Promise<{ exerciseId: string; planDayId: string; planId: string; timezone: string } | null> {
  const row = await db
    .selectFrom('plan_exercises as pe')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .innerJoin('users as student', 'student.id', 'p.trainee_id')
    .select([
      'pe.exercise_id as exercise_id',
      'pd.id as plan_day_id',
      'p.id as plan_id',
      'student.timezone as timezone',
    ])
    .where('pe.id', '=', planExerciseId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', '=', 'published')
    .where('pd.is_rest', '=', false)
    .limit(1)
    .executeTakeFirst();

  return row === undefined
    ? null
    : {
        exerciseId: row.exercise_id,
        planDayId: row.plan_day_id,
        planId: row.plan_id,
        timezone: row.timezone,
      };
}

export async function canLogPlanDay(
  db: Kysely<Database>,
  planDayId: string,
  studentId: string,
): Promise<boolean> {
  const day = await db
    .selectFrom('plan_days as pd')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select('pd.id')
    .where('pd.id', '=', planDayId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', '=', 'published')
    .where('pd.is_rest', '=', false)
    .where('pd.is_placeholder', '=', false)
    .executeTakeFirst();
  return day !== undefined;
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

export async function isAccessoryExercise(
  db: Kysely<Database>,
  exerciseId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('exercises')
    .select('exercise_type')
    .where('id', '=', exerciseId)
    .executeTakeFirst();
  return row?.exercise_type === 'accessory';
}

export class PlanDayRestError extends Error {}

export class SetLogValidationError extends Error {
  constructor(
    readonly code:
      | 'SET_WARMUP_PLAN_REQUIRED'
      | 'SET_WARMUP_INDEX'
      | 'SET_WARMUP_LIMIT'
      | 'SET_WARMUP_CONFLICT'
      | 'SET_EXTRA_LIMIT',
    readonly status: 409 | 422,
  ) {
    super(code);
  }
}

async function withWritablePlanDay<T>(
  db: Kysely<Database>,
  studentId: string,
  dayId: string | null,
  write: (db: Kysely<Database>) => Promise<T>,
  requireCoach = false,
): Promise<T> {
  if (!dayId) return write(db);
  return db.transaction().execute(async (trx) => {
    const ref = await trx
      .selectFrom('plan_days')
      .select('plan_id')
      .where('id', '=', dayId)
      .executeTakeFirst();
    if (!ref) throw new PlanDayRestError('PLAN_DAY_NOT_ACTIVE');
    const plan = await trx
      .selectFrom('plans')
      .select(['id', 'status', 'trainee_id', 'coach_id'])
      .where('id', '=', ref.plan_id)
      .forUpdate()
      .executeTakeFirst();
    const day = await trx
      .selectFrom('plan_days')
      .select('is_rest')
      .where('is_placeholder', '=', false)
      .where('id', '=', dayId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !plan ||
      !uuidEquals(plan.trainee_id, studentId) ||
      plan.status !== 'published' ||
      !day ||
      day.is_rest
    )
      throw new PlanDayRestError('PLAN_DAY_NOT_ACTIVE');
    if (requireCoach && plan.coach_id === null) {
      throw new SetLogValidationError('SET_WARMUP_PLAN_REQUIRED', 422);
    }
    return write(trx);
  });
}

export async function upsertSetLog(
  db: Kysely<Database>,
  studentId: string,
  input: SetLogInput,
): Promise<SetLogResult> {
  const failed = defaultFailed(input.failed);

  // Settlement stays in the student's hands: logging a set never writes a
  // completion — the explicit hold-to-complete call
  // (POST /plans/days/:dayId/complete) is the only student-side settlement
  // (David 2026-08-08, revising spec 035 拍板 1's auto half; coach backfill
  // imports are untouched). The plan/day lock serializes this write against
  // a coach switching the day to rest; completion is still entirely explicit.
  const saved = await withWritablePlanDay(
    db,
    studentId,
    input.plan_day_id,
    async (lockedDb) => {
      // The plan/day lock serializes identity and quota checks with every planned write.
      const warmup = input.is_warmup ?? false;
      const existing = await lockedDb
        .selectFrom('set_logs')
        .select('is_warmup')
        .where('student_id', '=', studentId)
        .where('plan_exercise_id', '=', input.plan_exercise_id)
        .where('set_index', '=', input.set_index)
        .executeTakeFirst();
      if (existing && existing.is_warmup !== warmup) {
        throw new SetLogValidationError('SET_WARMUP_CONFLICT', 409);
      }
      const prescribed = await lockedDb
        .selectFrom('plan_sets')
        .select((eb) => eb.fn.countAll<string | number>().as('count'))
        .where('plan_exercise_id', '=', input.plan_exercise_id)
        .executeTakeFirstOrThrow();
      const prescribedCount = Number(prescribed.count);
      if (warmup && input.set_index < prescribedCount) {
        throw new SetLogValidationError('SET_WARMUP_INDEX', 422);
      }
      if (!existing && input.set_index >= prescribedCount) {
        const count = await lockedDb
          .selectFrom('set_logs')
          .select((eb) => eb.fn.countAll<string | number>().as('count'))
          .where('student_id', '=', studentId)
          .where('plan_exercise_id', '=', input.plan_exercise_id)
          .where('is_warmup', '=', warmup)
          .$if(!warmup, (query) => query.where('set_index', '>=', prescribedCount))
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= (warmup ? 5 : 10)) {
          throw new SetLogValidationError(warmup ? 'SET_WARMUP_LIMIT' : 'SET_EXTRA_LIMIT', 422);
        }
      }
      return lockedDb
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
          actual_rir: input.actual_rir ?? null,
          completed: input.completed,
          failed,
          assumed: false,
          is_warmup: input.is_warmup ?? false,
        })
        .onConflict((oc) =>
          input.update_logged_date
            ? oc.columns(['student_id', 'plan_exercise_id', 'set_index']).doUpdateSet({
                weight_kg: (eb) => eb.ref('excluded.weight_kg'),
                reps: (eb) => eb.ref('excluded.reps'),
                rpe: (eb) => eb.ref('excluded.rpe'),
                ...(input.actual_rir !== undefined || input.rpe !== null
                  ? { actual_rir: input.actual_rir ?? null }
                  : {}),
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
                ...(input.actual_rir !== undefined || input.rpe !== null
                  ? { actual_rir: input.actual_rir ?? null }
                  : {}),
                completed: (eb) => eb.ref('excluded.completed'),
                failed: (eb) => eb.ref('excluded.failed'),
                assumed: false,
                logged_at: sql<Date>`now()`,
              }),
        )
        .returning(['id', 'logged_at'])
        .executeTakeFirstOrThrow();
    },
    input.is_warmup ?? false,
  );

  return {
    id: saved.id,
    logged_at: timestamp(saved.logged_at),
  };
}

export class AdhocDayConflictError extends Error {}

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
      ...(input.actual_rir !== undefined || input.rpe !== null
        ? { actual_rir: input.actual_rir ?? null }
        : {}),
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
    .where('plan_day_id', input.plan_day_id == null ? 'is' : '=', input.plan_day_id ?? null)
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
  const updated = await withWritablePlanDay(db, studentId, input.plan_day_id ?? null, (lockedDb) =>
    updateAdhocSetLog(lockedDb, studentId, input),
  );
  if (updated !== null) {
    return updated;
  }

  try {
    const row = await withWritablePlanDay(
      db,
      studentId,
      input.plan_day_id ?? null,
      async (lockedDb) =>
        lockedDb
          .insertInto('set_logs')
          .values({
            student_id: studentId,
            plan_exercise_id: null,
            plan_day_id: input.plan_day_id ?? null,
            exercise_id: input.exercise_id,
            logged_date: input.logged_date,
            adhoc: true,
            set_index: input.set_index,
            weight_kg: input.weight_kg,
            reps: input.reps,
            rpe: input.rpe,
            actual_rir: input.actual_rir ?? null,
            completed: input.completed,
            failed: input.failed,
            assumed: false,
          })
          .returning(['id', 'logged_at'])
          .executeTakeFirstOrThrow(),
    );

    return { id: row.id, logged_at: timestamp(row.logged_at) };
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const raced = await withWritablePlanDay(db, studentId, input.plan_day_id ?? null, (lockedDb) =>
      updateAdhocSetLog(lockedDb, studentId, input),
    );
    if (raced === null) {
      const existing = await db
        .selectFrom('set_logs')
        .select('plan_day_id')
        .where('student_id', '=', studentId)
        .where('exercise_id', '=', input.exercise_id)
        .where('logged_date', '=', input.logged_date)
        .where('set_index', '=', input.set_index)
        .where('adhoc', '=', true)
        .executeTakeFirst();
      if (
        existing &&
        !(existing.plan_day_id === null && input.plan_day_id == null) &&
        !uuidEquals(existing.plan_day_id, input.plan_day_id)
      ) {
        throw new AdhocDayConflictError('SETS_ADHOC_DAY_CONFLICT');
      }
      throw error;
    }
    return raced;
  }
}
