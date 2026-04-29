import type { Kysely } from 'kysely';

import type { Database } from './types';

export async function planIdForDay(
  db: Kysely<Database>,
  dayId: string,
  coachId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('plan_days')
    .innerJoin('plans', 'plans.id', 'plan_days.plan_id')
    .select('plan_days.plan_id')
    .where('plan_days.id', '=', dayId)
    .where('plans.coach_id', '=', coachId)
    .executeTakeFirst();

  return row?.plan_id ?? null;
}

export async function planIdForExercise(
  db: Kysely<Database>,
  exerciseId: string,
  coachId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('plan_exercises')
    .innerJoin('plan_days', 'plan_days.id', 'plan_exercises.plan_day_id')
    .innerJoin('plans', 'plans.id', 'plan_days.plan_id')
    .select('plan_days.plan_id')
    .where('plan_exercises.id', '=', exerciseId)
    .where('plans.coach_id', '=', coachId)
    .executeTakeFirst();

  return row?.plan_id ?? null;
}

export async function planIdForSet(
  db: Kysely<Database>,
  setId: string,
  coachId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('plan_sets')
    .innerJoin('plan_exercises', 'plan_exercises.id', 'plan_sets.plan_exercise_id')
    .innerJoin('plan_days', 'plan_days.id', 'plan_exercises.plan_day_id')
    .innerJoin('plans', 'plans.id', 'plan_days.plan_id')
    .select('plan_days.plan_id')
    .where('plan_sets.id', '=', setId)
    .where('plans.coach_id', '=', coachId)
    .executeTakeFirst();

  return row?.plan_id ?? null;
}
