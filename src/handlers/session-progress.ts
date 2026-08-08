import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../db/types';

type DbExecutor = Kysely<Database> | Transaction<Database>;

export interface SessionProgressLog {
  plan_exercise_id: string | null;
  completed: boolean;
  failed: boolean;
}

export interface SessionProgress {
  planDayIds: string[];
  plannedComplete: boolean;
  /** Total prescribed sets across the scoped days; lets callers refuse vacuous completion. */
  prescribedSetCount: number;
  /** Coach owning the touched plan(s); null for pure-adhoc or ambiguous days. */
  planCoachId: string | null;
}

/** The single coach owning every touched plan day, or null when absent/ambiguous. */
async function planCoachIdForDays(db: DbExecutor, planDayIds: string[]): Promise<string | null> {
  if (planDayIds.length === 0) return null;
  const planCoaches = await db
    .selectFrom('plan_days')
    .innerJoin('plans', 'plans.id', 'plan_days.plan_id')
    .select('plans.coach_id')
    .where('plan_days.id', 'in', planDayIds)
    .execute();
  const coachIds = [
    ...new Set(planCoaches.map((row) => row.coach_id).filter((id): id is string => id !== null)),
  ];
  return coachIds.length === 1 ? (coachIds[0] ?? null) : null;
}

/**
 * Canonical prescription completion calculation owned by the activity ledger
 * (sequence progression's server-side auto completion consumer was removed
 * 2026-08-08 — settlement is student-explicit). A failed set is a recorded
 * set; adhoc rows cannot
 * contribute because they have no plan_exercise_id.
 */
export async function sessionProgress(
  db: DbExecutor,
  logs: SessionProgressLog[],
  scopedPlanDayIds?: string[],
): Promise<SessionProgress> {
  const touchedExerciseIds = [
    ...new Set(logs.map((log) => log.plan_exercise_id).filter((id): id is string => id !== null)),
  ];
  if (scopedPlanDayIds === undefined && touchedExerciseIds.length === 0) {
    return { planDayIds: [], plannedComplete: false, prescribedSetCount: 0, planCoachId: null };
  }

  const touchedExercises =
    scopedPlanDayIds === undefined
      ? await db
          .selectFrom('plan_exercises')
          .select(['id', 'plan_day_id'])
          .where('id', 'in', touchedExerciseIds)
          .execute()
      : [];
  const planDayIds = [
    ...new Set(scopedPlanDayIds ?? touchedExercises.map((exercise) => exercise.plan_day_id)),
  ].sort();
  const planCoachId = await planCoachIdForDays(db, planDayIds);
  const plannedExercises =
    planDayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_exercises')
          .select(['id', 'plan_day_id'])
          .where('plan_day_id', 'in', planDayIds)
          .execute();
  const plannedExerciseIds = plannedExercises.map((exercise) => exercise.id);
  const planSets =
    plannedExerciseIds.length === 0
      ? []
      : await db
          .selectFrom('plan_sets')
          .select('plan_exercise_id')
          .where('plan_exercise_id', 'in', plannedExerciseIds)
          .execute();

  const prescribedByExercise = new Map<string, number>();
  for (const set of planSets) {
    prescribedByExercise.set(
      set.plan_exercise_id,
      (prescribedByExercise.get(set.plan_exercise_id) ?? 0) + 1,
    );
  }

  const submittedByExercise = new Map<string, number>();
  for (const log of logs) {
    if (log.plan_exercise_id === null || (!log.completed && !log.failed)) continue;
    submittedByExercise.set(
      log.plan_exercise_id,
      (submittedByExercise.get(log.plan_exercise_id) ?? 0) + 1,
    );
  }

  return {
    planDayIds,
    // Pre-extraction activity-ledger semantics, verbatim: a day with zero
    // prescriptions counts as complete here. Callers that must not treat that
    // vacuous case as done gate on prescribedSetCount.
    plannedComplete: plannedExercises.every(
      (exercise) =>
        (submittedByExercise.get(exercise.id) ?? 0) >= (prescribedByExercise.get(exercise.id) ?? 0),
    ),
    prescribedSetCount: planSets.length,
    planCoachId,
  };
}
