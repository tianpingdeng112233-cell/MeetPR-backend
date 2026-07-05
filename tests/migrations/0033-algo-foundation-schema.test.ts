import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const MIGRATION = 'db/migrations/0033-algo-foundation-schema.sql';
const STUDENT = '10000000-0000-4000-8000-000000000003';
const PLAN = '30000000-0000-4000-8000-000000000001';
const PLAN_EXERCISE = '50000000-0000-4000-8000-000000000001';
const EXERCISE = '20000000-0000-4000-8000-000000000001';

function createPre0033Schema(mem: ReturnType<typeof makeMigrationDb>): void {
  createBaseUsers(mem);
  createPlanSchema(mem);
  mem.public.none(`
    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
      set_number SMALLINT NOT NULL,
      target_reps SMALLINT NOT NULL,
      target_reps_max SMALLINT,
      intensity_mode TEXT NOT NULL,
      target_value NUMERIC(6,2) NOT NULL,
      set_type TEXT NOT NULL,
      rest_seconds INT,
      coach_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO plan_sets (
      plan_exercise_id, set_number, target_reps, target_reps_max,
      intensity_mode, target_value, set_type
    ) VALUES (
      '${PLAN_EXERCISE}', 1, 5, NULL, 'weight', 100.00, 'working'
    );

    CREATE TABLE set_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_exercise_id UUID REFERENCES plan_exercises(id) ON DELETE SET NULL,
      exercise_id UUID NOT NULL REFERENCES exercises(id),
      set_index INT NOT NULL,
      weight_kg NUMERIC(6,2) NOT NULL,
      reps INT NOT NULL,
      rpe NUMERIC(3,1),
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      failed BOOLEAN NOT NULL DEFAULT FALSE,
      adhoc BOOLEAN NOT NULL DEFAULT FALSE,
      logged_date DATE NOT NULL,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO set_logs (
      student_id, plan_exercise_id, exercise_id, set_index,
      weight_kg, reps, completed, logged_date
    ) VALUES (
      '${STUDENT}', '${PLAN_EXERCISE}', '${EXERCISE}', 0, 100.00, 5, TRUE, '2026-07-01'
    );

    CREATE TABLE student_onboarding_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      deadlift_style TEXT,
      CONSTRAINT student_onboarding_profiles_deadlift_style_check
        CHECK (deadlift_style IS NULL OR deadlift_style IN ('conventional', 'sumo'))
    );

    INSERT INTO student_onboarding_profiles (user_id, deadlift_style)
    VALUES ('${STUDENT}', 'conventional');

    CREATE TABLE readiness_checkins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      checkin_date DATE NOT NULL,
      sleep_quality SMALLINT NOT NULL,
      mood SMALLINT NOT NULL,
      stress SMALLINT NOT NULL,
      muscle_fatigue JSONB NOT NULL DEFAULT '[]',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, checkin_date)
    );

    INSERT INTO readiness_checkins (
      student_id, checkin_date, sleep_quality, mood, stress, muscle_fatigue
    ) VALUES (
      '${STUDENT}', '2026-07-01', 4, 4, 2, '[]'
    );
  `);
}

describe('migration 0033 algo foundation schema', () => {
  it('adds nullable legacy columns without mutating existing rows', () => {
    const mem = makeMigrationDb();
    createPre0033Schema(mem);
    runMigration(mem, MIGRATION);

    const plan = mem.public.one(`
      SELECT block_type, mesocycle_phase, training_max, tm_set_at
      FROM plans
      WHERE id = '${PLAN}';
    `);
    expect(plan).toEqual({
      block_type: null,
      mesocycle_phase: null,
      training_max: null,
      tm_set_at: null,
    });

    const set = mem.public.one(`
      SELECT method_anchor, effort_method, rpe_low, pct_of_tm, intra_set_rest, load_mode
      FROM plan_sets
      WHERE plan_exercise_id = '${PLAN_EXERCISE}';
    `);
    expect(set).toEqual({
      method_anchor: null,
      effort_method: null,
      rpe_low: null,
      pct_of_tm: null,
      intra_set_rest: null,
      load_mode: null,
    });

    const setLog = mem.public.one(`
      SELECT actual_rir, accommodating_tension, e1rm_confidence, mean_velocity
      FROM set_logs;
    `);
    expect(setLog).toEqual({
      actual_rir: null,
      accommodating_tension: null,
      e1rm_confidence: null,
      mean_velocity: null,
    });

    const exercise = mem.public.one(`
      SELECT
        base_exercise_id,
        stance,
        grip,
        bar_position,
        pause,
        tempo,
        sticking_point_target,
        variation_key,
        pause_duration,
        deficit_height,
        block_height,
        rom_modifier,
        exercise_tier,
        fatigue_tier,
        overload_modality,
        required_equipment
      FROM exercises
      WHERE id = '${EXERCISE}';
    `);
    expect(exercise).toEqual({
      base_exercise_id: null,
      stance: null,
      grip: null,
      bar_position: null,
      pause: null,
      tempo: null,
      sticking_point_target: null,
      variation_key: null,
      pause_duration: null,
      deficit_height: null,
      block_height: null,
      rom_modifier: null,
      exercise_tier: null,
      fatigue_tier: null,
      overload_modality: null,
      required_equipment: null,
    });

    const readiness = mem.public.one(`
      SELECT motivation, energy
      FROM readiness_checkins;
    `);
    expect(readiness).toEqual({ motivation: null, energy: null });
  });

  it('creates algorithm tables and extends deadlift_style to both', () => {
    const mem = makeMigrationDb();
    createPre0033Schema(mem);
    runMigration(mem, MIGRATION);

    mem.public.none(`
      UPDATE student_onboarding_profiles
      SET deadlift_style = 'both'
      WHERE user_id = '${STUDENT}';

      INSERT INTO athlete_lift_state (student_id, lift_family, dev_stage, method_anchor)
      VALUES ('${STUDENT}', 'deadlift', 'intermediate', 'tm_pct');

      INSERT INTO wave_templates (wave_name, phase, set_count, reps, pct_of_tm, rep_standard)
      VALUES ('5s', 'realization', 3, 5, 85.0, 5);

      INSERT INTO athlete_capacity_profiles (student_id, lift_family, mev, mav, mrv)
      VALUES ('${STUDENT}', 'squat', 8, 12, 18);

      INSERT INTO variation_logs (student_id, variation_key, last_used_week, best_e1rm)
      VALUES ('${STUDENT}', 'squat:pause:2ct', '2026-07-01', 142.5);
    `);

    const liftState = mem.public.one(`
      SELECT deadlift_stance
      FROM athlete_lift_state
      WHERE student_id = '${STUDENT}' AND lift_family = 'deadlift';
    `);
    expect(liftState).toEqual({ deadlift_stance: 'both' });

    expect(() => {
      mem.public.none(`
        INSERT INTO athlete_lift_state (student_id, lift_family, dev_stage)
        VALUES ('${STUDENT}', 'bench', 'beginner');
      `);
    }).toThrow();

    expect(mem.public.many(`SELECT * FROM wave_templates;`)).toHaveLength(1);
    expect(mem.public.many(`SELECT * FROM athlete_capacity_profiles;`)).toHaveLength(1);
    expect(mem.public.many(`SELECT * FROM variation_logs;`)).toHaveLength(1);
  });
});
