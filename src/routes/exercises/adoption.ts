import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, ExercisesTable } from '../../db/types';

export const ADOPTED_ATTRIBUTES = [
  'name_en',
  'exercise_type',
  'main_lift_family',
  'is_competition_lift',
  'competition_stance',
  'muscle_groups',
  'equipment',
  'movement_pattern',
] as const;
type ExerciseRow = Selectable<ExercisesTable>;

// CASE preserves an official NULL (coalesce would resurrect the alias value).
export function canonicalAttribute<K extends (typeof ADOPTED_ATTRIBUTES)[number]>(key: K) {
  return sql<
    ExerciseRow[K]
  >`case when canonical.id is not null then ${sql.ref(`canonical.${key}`)} else ${sql.ref(`exercises.${key}`)} end`;
}

export async function resolveAdoptedExercise(
  db: Kysely<Database>,
  row: ExerciseRow,
): Promise<ExerciseRow> {
  if (row.canonical_exercise_id === null) return row;
  const official = await db
    .selectFrom('exercises')
    .selectAll()
    .where('id', '=', row.canonical_exercise_id)
    .executeTakeFirstOrThrow();
  return { ...row, ...Object.fromEntries(ADOPTED_ATTRIBUTES.map((key) => [key, official[key]])) };
}
