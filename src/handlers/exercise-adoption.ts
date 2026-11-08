import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import { toExercise } from '../routes/plans/serialization';

export async function listCustomExercises(db: Kysely<Database>) {
  const [exercises, usage] = await Promise.all([
    db
      .selectFrom('exercises as e')
      .leftJoin('coach_profiles as c', 'c.user_id', 'e.created_by_coach_id')
      .selectAll('e')
      .select('c.display_name as coach_name')
      .orderBy('e.name')
      .orderBy('e.id')
      .execute(),
    db
      .selectFrom('plan_exercises as pe')
      .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
      .select(['pe.exercise_id', 'pd.plan_id'])
      .distinct()
      .execute(),
  ]);
  const plansByExercise = new Map<string, Set<string>>();
  for (const row of usage) {
    const plans = plansByExercise.get(row.exercise_id) ?? new Set<string>();
    plans.add(row.plan_id);
    plansByExercise.set(row.exercise_id, plans);
  }
  const byId = new Map(exercises.map((row) => [row.id, row]));
  const pending = new Map<
    string,
    { rows: ReturnType<typeof pendingRow>[]; coaches: Set<string>; plans: Set<string> }
  >();
  const adopted = new Map<
    string,
    {
      official: { id: string; name: string; name_en: string | null };
      rows: ReturnType<typeof adoptedRow>[];
    }
  >();
  function commonRow(row: (typeof exercises)[number]) {
    return {
      exercise_id: row.id,
      name: row.name,
      coach_id: row.created_by_coach_id,
      coach_name: row.coach_name,
      plan_count: plansByExercise.get(row.id)?.size ?? 0,
    };
  }
  function pendingRow(row: (typeof exercises)[number]) {
    const {
      id: _id,
      name: _name,
      created_by_coach_id: _coach,
      created_at: _created,
      canonical_exercise_id: _canonical,
      adopted: _adopted,
      ...attributes
    } = toExercise(row);
    return { ...commonRow(row), ...attributes };
  }
  function adoptedRow(row: (typeof exercises)[number]) {
    return { ...commonRow(row), adopted_at: row.adopted_at?.toISOString() ?? null };
  }
  for (const row of exercises) {
    if (row.created_by_coach_id === null) continue;
    if (row.canonical_exercise_id !== null) {
      const official = byId.get(row.canonical_exercise_id);
      if (!official) throw new Error('Missing canonical exercise');
      const group = adopted.get(official.id) ?? {
        official: { id: official.id, name: official.name, name_en: official.name_en },
        rows: [],
      };
      group.rows.push(adoptedRow(row));
      adopted.set(official.id, group);
    } else {
      const key = row.name
        .replace(/[！-～]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
        .replace(/\s/gu, '')
        .toLowerCase();
      const group = pending.get(key) ?? {
        rows: [],
        coaches: new Set<string>(),
        plans: new Set<string>(),
      };
      group.rows.push(pendingRow(row));
      group.coaches.add(row.created_by_coach_id);
      for (const plan of plansByExercise.get(row.id) ?? []) group.plans.add(plan);
      pending.set(key, group);
    }
  }
  return {
    pending: [...pending.entries()]
      .map(([key, group]) => {
        group.rows.sort(
          (a, b) =>
            b.plan_count - a.plan_count ||
            a.name.localeCompare(b.name) ||
            a.exercise_id.localeCompare(b.exercise_id),
        );
        return {
          key,
          display_name: group.rows[0]?.name ?? key,
          coach_count: group.coaches.size,
          plan_count: group.plans.size,
          rows: group.rows,
        };
      })
      .sort(
        (a, b) =>
          b.plan_count - a.plan_count ||
          b.coach_count - a.coach_count ||
          a.key.localeCompare(b.key),
      ),
    adopted: [...adopted.values()].sort(
      (a, b) =>
        a.official.name.localeCompare(b.official.name) ||
        a.official.id.localeCompare(b.official.id),
    ),
  };
}
