BEGIN;

SET search_path TO public;

CREATE TABLE plan_day_completions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_day_id  UUID NOT NULL REFERENCES plan_days (id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES users (id),
  source       TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'backfill')),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plan_day_completions_day_uidx UNIQUE (plan_day_id)
);

CREATE INDEX plan_day_completions_student_idx
  ON plan_day_completions (student_id, completed_at DESC);

ALTER TABLE plans ADD COLUMN published_at TIMESTAMPTZ;

UPDATE plans
SET published_at = updated_at
WHERE status IN ('published', 'completed');

COMMIT;
