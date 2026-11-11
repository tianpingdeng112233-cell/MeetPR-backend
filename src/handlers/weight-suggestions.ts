import type { Kysely, Selectable } from 'kysely';
import type { Database, PlanSetsTable } from '../db/types';
import { trainingDay } from '../utils/date';
import { dateOnly } from './serialization';

function targetRpe(set: Selectable<PlanSetsTable>): number | null {
  if (set.target_weight !== null || set.weight_low !== null || set.weight_high !== null)
    return null;
  const value =
    set.load_mode === 'rpe' || set.load_mode === 'free_weight' || set.load_mode === 'bodyweight'
      ? set.target_rpe
      : set.load_mode === null && set.intensity_mode === 'rpe'
        ? set.target_value
        : null;
  return value === null ? null : Number(value);
}

function exercisePositions(exercises: { id: string; plan_day_id: string; sort_order: number }[]) {
  const positions = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const exercise of [...exercises].sort(
    (a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id),
  )) {
    const position = (counts.get(exercise.plan_day_id) ?? 0) + 1;
    positions.set(exercise.id, position);
    counts.set(exercise.plan_day_id, position);
  }
  return positions;
}

export async function fetchWeightSuggestions(
  db: Kysely<Database>,
  studentId: string,
  planDayId: string,
) {
  const day = await db
    .selectFrom('plan_days as pd')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .innerJoin('users as u', 'u.id', 'p.trainee_id')
    .select(['pd.id', 'u.timezone'])
    .where('pd.id', '=', planDayId)
    .where('p.trainee_id', '=', studentId)
    .executeTakeFirst();
  if (!day) return null;
  const exercises = await db
    .selectFrom('plan_exercises')
    .select(['id', 'exercise_id', 'plan_day_id', 'sort_order'])
    .where('plan_day_id', '=', planDayId)
    .execute();
  if (exercises.length === 0) return [];
  const sets = await db
    .selectFrom('plan_sets')
    .selectAll()
    .where(
      'plan_exercise_id',
      'in',
      exercises.map((exercise) => exercise.id),
    )
    .orderBy('set_number', 'asc')
    .execute();
  const targets = sets.flatMap((set) => {
    const rpe = targetRpe(set);
    const exercise = exercises.find((candidate) => candidate.id === set.plan_exercise_id);
    return rpe === null || !exercise ? [] : [{ set, rpe, exercise }];
  });
  if (targets.length === 0) return [];
  const logs = await db
    .selectFrom('set_logs as sl')
    .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select([
      'sl.id',
      'sl.exercise_id',
      'sl.plan_exercise_id',
      'pe.plan_day_id',
      'sl.reps',
      'sl.rpe',
      'sl.weight_kg',
      'sl.logged_date',
      'sl.logged_at',
    ])
    .where('sl.student_id', '=', studentId)
    .where('p.trainee_id', '=', studentId)
    .where('sl.exercise_id', 'in', [
      ...new Set(targets.map((target) => target.exercise.exercise_id)),
    ])
    .where('sl.completed', '=', true)
    .where('sl.failed', '=', false)
    .where('sl.assumed', '=', false)
    .where('sl.adhoc', '=', false)
    .where('sl.weight_kg', 'is not', null)
    .where('sl.logged_date', '<', trainingDay(new Date(), day.timezone))
    .orderBy('sl.logged_at', 'desc')
    .orderBy('sl.id', 'desc')
    .execute();
  if (logs.length === 0) return [];
  // Rank all siblings, including exercises without matching logs. Raw sort_order may have gaps.
  const historicalExercises = await db
    .selectFrom('plan_exercises')
    .select(['id', 'plan_day_id', 'sort_order'])
    .where('plan_day_id', 'in', [...new Set(logs.map((log) => log.plan_day_id))])
    .execute();
  const currentPositions = exercisePositions(exercises);
  const previousPositions = exercisePositions(historicalExercises);
  return targets.flatMap(({ set, rpe, exercise }) => {
    const log = logs.find(
      (candidate) =>
        candidate.exercise_id === exercise.exercise_id &&
        candidate.reps === set.target_reps &&
        candidate.rpe !== null &&
        Number(candidate.rpe) === rpe &&
        candidate.plan_exercise_id !== null &&
        previousPositions.get(candidate.plan_exercise_id) === currentPositions.get(exercise.id),
    );
    return !log
      ? []
      : [
          {
            plan_set_id: set.id,
            weight_kg: Number(log.weight_kg).toFixed(2),
            source_set_log_id: log.id,
            source_logged_date: dateOnly(log.logged_date),
          },
        ];
  });
}
