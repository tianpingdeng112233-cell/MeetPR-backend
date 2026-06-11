-- Migration 0012: evaluation summaries (3 free-text fields) + version snapshots.
-- One active summary row per (student, coach); every save appends a version row
-- recording whether the student was notified (spec 005 D10).
-- Spec: specs/005-bind-eval-profile/SPEC.md
-- Source: evaluation-workflow.md v1.1 §5.6

BEGIN;

CREATE TABLE student_evaluations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL when the coach skipped the evaluation period (acquaintance path).
  evaluation_period_id  UUID REFERENCES evaluation_periods(id) ON DELETE SET NULL,
  overall_assessment    TEXT NOT NULL CHECK (length(trim(overall_assessment)) BETWEEN 1 AND 10000),
  training_plan         TEXT NOT NULL CHECK (length(trim(training_plan)) BETWEEN 1 AND 10000),
  words_to_student      TEXT CHECK (words_to_student IS NULL OR length(trim(words_to_student)) BETWEEN 1 AND 10000),
  first_saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (student_id, coach_id)
);

CREATE TABLE student_evaluation_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id       UUID NOT NULL REFERENCES student_evaluations(id) ON DELETE CASCADE,
  overall_assessment  TEXT NOT NULL,
  training_plan       TEXT NOT NULL,
  words_to_student    TEXT,
  notified_student    BOOLEAN NOT NULL DEFAULT FALSE,
  saved_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX student_evaluation_versions_eval_idx
  ON student_evaluation_versions (evaluation_id, saved_at DESC);

COMMIT;
