-- Migration 0005: student set logs.
-- Spec: specs/003-student-actions/SPEC.md

BEGIN;

CREATE TABLE set_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
  set_index        INT NOT NULL CHECK (set_index >= 0),
  weight_kg        NUMERIC(6,2) NOT NULL CHECK (weight_kg >= 0 AND weight_kg <= 9999.99),
  reps             INT NOT NULL CHECK (reps >= 0 AND reps <= 99),
  rpe              NUMERIC(3,1) CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10.0)),
  completed        BOOLEAN NOT NULL DEFAULT FALSE,
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, plan_exercise_id, set_index)
);

CREATE INDEX set_logs_student_logged_idx ON set_logs (student_id, logged_at DESC);
CREATE INDEX set_logs_plan_exercise_idx  ON set_logs (plan_exercise_id);

COMMIT;
