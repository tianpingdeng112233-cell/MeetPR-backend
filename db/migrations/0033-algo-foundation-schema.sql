-- Migration 0033: algorithm planning foundation schema (spec 014).
-- Pure additive engine data base: nullable legacy columns, four standalone
-- tables, and the enum/check vocabulary needed by W1+ plan generation.

BEGIN;

CREATE TYPE method_anchor AS ENUM (
  'linear_load',
  'tm_pct',
  'e1rm_rpe',
  'double_progression'
);

CREATE TYPE dev_stage AS ENUM (
  'novice',
  'intermediate',
  'advanced'
);

CREATE TYPE block_type AS ENUM (
  'hypertrophy',
  'strength',
  'peaking',
  'active_rest'
);

CREATE TYPE mesocycle_phase AS ENUM (
  'accumulation',
  'intensification',
  'realization',
  'deload'
);

CREATE TYPE e1rm_confidence AS ENUM (
  'normal',
  'low'
);

CREATE TYPE deadlift_style AS ENUM (
  'conventional',
  'sumo',
  'both'
);

ALTER TABLE student_onboarding_profiles
  DROP CONSTRAINT IF EXISTS student_onboarding_profiles_deadlift_style_check,
  ADD CONSTRAINT student_onboarding_profiles_deadlift_style_check
    CHECK (deadlift_style IS NULL OR deadlift_style IN ('conventional', 'sumo', 'both'));

ALTER TABLE plans
  ADD COLUMN block_type block_type,
  ADD COLUMN mesocycle_phase mesocycle_phase,
  ADD COLUMN training_max NUMERIC,
  ADD COLUMN tm_set_at TIMESTAMPTZ;

COMMENT ON COLUMN plans.block_type IS 'Training block type for algorithm-generated/read-only plan metadata.';
COMMENT ON COLUMN plans.mesocycle_phase IS 'JTS-style mesocycle phase for read-only plan metadata.';
COMMENT ON COLUMN plans.training_max IS 'Server-computed TM = ceil(0.9 * true 1RM, 2.5kg); client supplied TM is not trusted.';
COMMENT ON COLUMN plans.tm_set_at IS 'Server timestamp for TM freshness; W2+ %TM prescriptions reject values older than 6 weeks.';

ALTER TABLE plan_sets
  ADD COLUMN method_anchor method_anchor,
  ADD COLUMN effort_method TEXT CHECK (effort_method IS NULL OR effort_method IN ('max', 'dynamic', 'repetition')),
  ADD COLUMN rpe_low SMALLINT,
  ADD COLUMN rpe_high SMALLINT,
  ADD COLUMN fatigue_pct_target NUMERIC,
  ADD COLUMN accommodating_tension BOOLEAN,
  ADD COLUMN linear_increment NUMERIC,
  ADD COLUMN amrap_cap SMALLINT,
  ADD COLUMN backoff_pct NUMERIC,
  ADD COLUMN rir_target SMALLINT,
  ADD COLUMN rep_standard SMALLINT,
  ADD COLUMN set_scheme_hint JSONB,
  ADD COLUMN volume_is_cap BOOLEAN,
  ADD COLUMN pct_of_tm NUMERIC,
  ADD COLUMN intra_set_rest SMALLINT,
  ADD COLUMN load_mode TEXT;

COMMENT ON COLUMN plan_sets.rep_standard IS 'Wave bracket standard (10/8/5/3), not a universal 5-rep standard.';
COMMENT ON COLUMN plan_sets.load_mode IS 'Extended load prescription mode; intentionally coexists with intensity_mode until W2 reconciliation.';
COMMENT ON COLUMN plan_sets.intra_set_rest IS 'Cluster intra-set short rest; distinct from rest_seconds between sets.';

ALTER TABLE set_logs
  ADD COLUMN actual_rir SMALLINT,
  ADD COLUMN accommodating_tension BOOLEAN,
  ADD COLUMN e1rm_confidence e1rm_confidence,
  ADD COLUMN mean_velocity NUMERIC;

ALTER TABLE exercises
  ADD COLUMN base_exercise_id UUID REFERENCES exercises(id) ON DELETE SET NULL,
  ADD COLUMN stance TEXT,
  ADD COLUMN grip TEXT,
  ADD COLUMN bar_position TEXT,
  ADD COLUMN pause BOOLEAN,
  ADD COLUMN tempo TEXT,
  ADD COLUMN sticking_point_target TEXT,
  ADD COLUMN variation_key TEXT,
  ADD COLUMN pause_duration NUMERIC,
  ADD COLUMN deficit_height NUMERIC,
  ADD COLUMN block_height NUMERIC,
  ADD COLUMN rom_modifier TEXT,
  ADD COLUMN exercise_tier TEXT,
  ADD COLUMN fatigue_tier TEXT,
  ADD COLUMN overload_modality TEXT,
  ADD COLUMN required_equipment TEXT[];

COMMENT ON COLUMN exercises.exercise_tier IS 'JTS auxiliary role tier {variation, supplementary, accessory}; distinct from exercise_type identity.';
COMMENT ON COLUMN exercises.required_equipment IS 'Algorithm gym-tier equipment token list; distinct from existing equipment enum array.';

ALTER TABLE readiness_checkins
  ADD COLUMN motivation SMALLINT,
  ADD COLUMN energy SMALLINT;

CREATE TABLE athlete_lift_state (
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lift_family TEXT NOT NULL CHECK (lift_family IN ('squat', 'bench', 'deadlift')),
  dev_stage dev_stage,
  method_anchor method_anchor,
  seed_perf JSONB,
  sticking_point_target TEXT,
  deadlift_stance deadlift_style DEFAULT 'both',
  PRIMARY KEY (student_id, lift_family)
);

CREATE TABLE wave_templates (
  wave_name TEXT NOT NULL CHECK (wave_name IN ('10s', '8s', '5s', '3s')),
  phase mesocycle_phase NOT NULL,
  set_count SMALLINT NOT NULL,
  reps SMALLINT NOT NULL,
  pct_of_tm NUMERIC NOT NULL,
  amrap_cap SMALLINT,
  rep_standard SMALLINT,
  PRIMARY KEY (wave_name, phase)
);

COMMENT ON TABLE wave_templates IS 'W0 skeleton only; W2 seeds the 10s/8s/5s/3s grid (10/20, 8/18, 5/15, 3/13).';
COMMENT ON COLUMN wave_templates.amrap_cap IS 'Realization top set cap only.';
COMMENT ON COLUMN wave_templates.rep_standard IS 'Realization top set bracket value {10,8,5,3}.';

CREATE TABLE athlete_capacity_profiles (
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lift_family TEXT NOT NULL CHECK (lift_family IN ('squat', 'bench', 'deadlift')),
  mev SMALLINT,
  mav SMALLINT,
  mrv SMALLINT,
  phase_scale JSONB,
  PRIMARY KEY (student_id, lift_family)
);

CREATE TABLE variation_logs (
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variation_key TEXT NOT NULL,
  last_used_week DATE,
  best_e1rm NUMERIC,
  PRIMARY KEY (student_id, variation_key)
);

COMMIT;

-- Rollback (staging drills only):
--   BEGIN;
--   DROP TABLE variation_logs;
--   DROP TABLE athlete_capacity_profiles;
--   DROP TABLE wave_templates;
--   DROP TABLE athlete_lift_state;
--   ALTER TABLE readiness_checkins DROP COLUMN energy, DROP COLUMN motivation;
--   ALTER TABLE exercises
--     DROP COLUMN required_equipment, DROP COLUMN overload_modality, DROP COLUMN fatigue_tier,
--     DROP COLUMN exercise_tier, DROP COLUMN rom_modifier, DROP COLUMN block_height,
--     DROP COLUMN deficit_height, DROP COLUMN pause_duration, DROP COLUMN variation_key,
--     DROP COLUMN sticking_point_target, DROP COLUMN tempo, DROP COLUMN pause,
--     DROP COLUMN bar_position, DROP COLUMN grip, DROP COLUMN stance, DROP COLUMN base_exercise_id;
--   ALTER TABLE set_logs
--     DROP COLUMN mean_velocity, DROP COLUMN e1rm_confidence,
--     DROP COLUMN accommodating_tension, DROP COLUMN actual_rir;
--   ALTER TABLE plan_sets
--     DROP COLUMN load_mode, DROP COLUMN intra_set_rest, DROP COLUMN pct_of_tm,
--     DROP COLUMN volume_is_cap, DROP COLUMN set_scheme_hint, DROP COLUMN rep_standard,
--     DROP COLUMN rir_target, DROP COLUMN backoff_pct, DROP COLUMN amrap_cap,
--     DROP COLUMN linear_increment, DROP COLUMN accommodating_tension,
--     DROP COLUMN fatigue_pct_target, DROP COLUMN rpe_high, DROP COLUMN rpe_low,
--     DROP COLUMN effort_method, DROP COLUMN method_anchor;
--   ALTER TABLE plans DROP COLUMN tm_set_at, DROP COLUMN training_max, DROP COLUMN mesocycle_phase, DROP COLUMN block_type;
--   ALTER TABLE student_onboarding_profiles
--     DROP CONSTRAINT student_onboarding_profiles_deadlift_style_check,
--     ADD CONSTRAINT student_onboarding_profiles_deadlift_style_check
--       CHECK (deadlift_style IS NULL OR deadlift_style IN ('conventional', 'sumo'));
--   DROP TYPE deadlift_style;
--   DROP TYPE e1rm_confidence;
--   DROP TYPE mesocycle_phase;
--   DROP TYPE block_type;
--   DROP TYPE dev_stage;
--   DROP TYPE method_anchor;
--   COMMIT;
