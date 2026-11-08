-- Spec 053: preserve every custom exercise and its historical references.
BEGIN;
SET search_path TO public;
ALTER TABLE exercises
  ADD COLUMN IF NOT EXISTS canonical_exercise_id UUID REFERENCES exercises(id) ON DELETE RESTRICT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS adopted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS exercises_canonical_exercise_id_idx
  ON exercises (canonical_exercise_id) WHERE canonical_exercise_id IS NOT NULL;
COMMIT;
-- Rollback: roll back the application first and retain these additive columns and
-- links. Dropping them would destroy adoption decisions; no data rollback needed.
