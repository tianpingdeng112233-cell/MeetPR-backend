import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const MIGRATION = 'db/migrations/0022-sync-coach-import-exercises.sql';

// The 3 exercises this migration adds (ids ca70-…04dd..04df), mirroring the
// alias-amendment additions to exercise-catalog-v2.json.
const NEW_IDS = [
  '00000000-0000-0000-ca70-0000000004dd',
  '00000000-0000-0000-ca70-0000000004de',
  '00000000-0000-0000-ca70-0000000004df',
];
const newIdList = NEW_IDS.map((id) => `'${id}'`).join(', ');

interface ExerciseRow {
  id: string;
  name: string;
  name_en: string | null;
  exercise_type: string;
  main_lift_family: string | null;
  is_competition_lift: boolean;
  muscle_groups: string[];
  equipment: string[];
  movement_pattern: string[];
}

// The real catalog table is built by 0002 + the generated 0002.1, which pg-mem can't
// execute (array `<@` checks, DROP CONSTRAINT). createPlanSchema stands in with the
// same columns; full constraint compatibility against the 0002.1-rebuilt CHECKs is
// verified on real Postgres, not here.
describe('migration 0022 coach-import catalog sync', () => {
  it('inserts the three import-coverage exercises with the expected metadata', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, MIGRATION);

    const rows = mem.public.many(
      `SELECT id, name, name_en, exercise_type, main_lift_family,
              is_competition_lift, muscle_groups, equipment, movement_pattern
       FROM exercises WHERE id IN (${newIdList})`,
    ) as ExerciseRow[];
    expect(rows).toHaveLength(3);

    // Full-field assertions guard against cross-repo drift from the iOS bundle —
    // e.g. 弹力带窄推 silently losing `band`, which is the whole point of this sync.
    const eccentric = rows.find((r) => r.name_en === 'Eccentric Bench Press');
    expect(eccentric?.name).toBe('离心卧推');
    expect(eccentric?.exercise_type).toBe('main_lift_variation');
    expect(eccentric?.main_lift_family).toBe('bench');
    expect(eccentric?.is_competition_lift).toBe(false);
    expect(eccentric?.muscle_groups).toEqual(['chest']);
    expect(eccentric?.equipment).toEqual(['barbell']);
    expect(eccentric?.movement_pattern).toEqual(['horizontal_push']);

    const banded = rows.find((r) => r.name_en === 'Banded Close-Grip Bench Press');
    expect(banded?.name).toBe('弹力带窄推');
    expect(banded?.main_lift_family).toBe('bench');
    expect(banded?.equipment).toEqual(['barbell', 'band']);
    expect(banded?.movement_pattern).toEqual(['horizontal_push']);

    const ssbTempo = rows.find((r) => r.name_en === 'Safety Bar Tempo Squat');
    expect(ssbTempo?.name).toBe('安全杠节奏深蹲');
    expect(ssbTempo?.exercise_type).toBe('main_lift_variation');
    expect(ssbTempo?.main_lift_family).toBe('squat');
    expect(ssbTempo?.muscle_groups).toEqual(['quad']);
    expect(ssbTempo?.equipment).toEqual(['specialty_bar']);
    expect(ssbTempo?.movement_pattern).toEqual(['squat']);
  });

  it('is idempotent on re-apply', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    expect(mem.public.many(`SELECT id FROM exercises WHERE id IN (${newIdList})`)).toHaveLength(3);
  });
});
