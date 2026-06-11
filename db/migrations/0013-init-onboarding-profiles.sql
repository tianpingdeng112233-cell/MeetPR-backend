-- Migration 0013: student onboarding profile (7-step wizard, 29 fields) +
-- Step-6 upload linkage table.
-- All product columns are nullable: the wizard upserts step by step; required
-- semantics are enforced server-side by POST /students/me/onboarding/complete.
-- Array token vocabularies (training_days, injury_areas, ...) are enforced in
-- zod, not SQL (spec 005 D11).
-- Spec: specs/005-bind-eval-profile/SPEC.md
-- Source: student-onboarding.md v2.4 (per-step data-model notes)

BEGIN;

CREATE TABLE student_onboarding_profiles (
  user_id                      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Step 1: basics
  unit_preference              TEXT CHECK (unit_preference IS NULL OR unit_preference IN ('kg', 'lb')),
  gender                       TEXT CHECK (gender IS NULL OR gender IN ('male', 'female', 'other')),
  birth_date                   DATE,
  height_cm                    NUMERIC(5,1) CHECK (height_cm IS NULL OR (height_cm > 0 AND height_cm < 300)),
  weight_kg                    NUMERIC(5,2) CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg < 500)),
  -- Step 2: training background (training_years: 0 = <1 year, 10 = 10+ years)
  training_years               SMALLINT CHECK (training_years IS NULL OR training_years BETWEEN 0 AND 10),
  squat_stance                 TEXT CHECK (squat_stance IS NULL OR squat_stance IN ('high_bar', 'low_bar')),
  deadlift_style               TEXT CHECK (deadlift_style IS NULL OR deadlift_style IN ('conventional', 'sumo')),
  bench_grip                   TEXT CHECK (bench_grip IS NULL OR bench_grip IN ('narrow', 'standard', 'wide')),
  -- Step 3: 1RM (student-locked once completed_at is set; coach endpoint only)
  squat_1rm_kg                 NUMERIC(6,2) CHECK (squat_1rm_kg IS NULL OR (squat_1rm_kg > 0 AND squat_1rm_kg < 1000)),
  bench_1rm_kg                 NUMERIC(6,2) CHECK (bench_1rm_kg IS NULL OR (bench_1rm_kg > 0 AND bench_1rm_kg < 1000)),
  deadlift_1rm_kg              NUMERIC(6,2) CHECK (deadlift_1rm_kg IS NULL OR (deadlift_1rm_kg > 0 AND deadlift_1rm_kg < 1000)),
  -- Step 4: training environment ('mon'..'sun'; 2-6 entries enforced in zod)
  training_days                TEXT[],
  gym_tier                     TEXT CHECK (gym_tier IS NULL OR gym_tier IN ('home_with_rack', 'commercial', 'professional')),
  equipment_overrides          TEXT[],
  -- Step 5: recovery (all 1-5 scale bands; sleep_hours band: 1=<=5h .. 5=9h+)
  daily_life_intensity         SMALLINT CHECK (daily_life_intensity IS NULL OR daily_life_intensity BETWEEN 1 AND 5),
  life_stress                  SMALLINT CHECK (life_stress IS NULL OR life_stress BETWEEN 1 AND 5),
  recovery_speed               SMALLINT CHECK (recovery_speed IS NULL OR recovery_speed BETWEEN 1 AND 5),
  sleep_hours                  SMALLINT CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 1 AND 5),
  -- Step 6: training materials (uploads live in onboarding_uploads)
  muscle_groups_to_strengthen  TEXT[] CHECK (muscle_groups_to_strengthen IS NULL OR array_length(muscle_groups_to_strengthen, 1) <= 3),
  -- Step 7: extras
  injury_notes                 TEXT CHECK (injury_notes IS NULL OR length(injury_notes) BETWEEN 1 AND 2000),
  injury_areas                 TEXT[],
  is_competing                 BOOLEAN,
  competition_date             DATE,
  target_weight_class          TEXT CHECK (target_weight_class IS NULL OR length(target_weight_class) BETWEEN 1 AND 100),
  note_to_coach                TEXT CHECK (note_to_coach IS NULL OR length(note_to_coach) BETWEEN 1 AND 2000),
  -- Meta
  completed_at                 TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 6 uploads: attachment linkage. NO FK on attachment_id -- the attachments
-- table is created by parallel spec 004 (migration 0007); the integration spec
-- adds the FK once both have landed (spec 005 D17).
CREATE TABLE onboarding_uploads (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id  UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, attachment_id)
);

COMMIT;
