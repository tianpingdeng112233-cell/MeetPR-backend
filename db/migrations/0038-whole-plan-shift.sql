-- Migration 0038: evolve single-day shifts into append-only whole-plan shift
-- batches so undoing the latest batch reveals the previous effective dates.

BEGIN;

SET search_path TO public;

ALTER TABLE plan_day_shifts
  ADD COLUMN batch_id UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- V1 rows were independent shift actions, so each receives its own batch.
UPDATE plan_day_shifts
SET batch_id = gen_random_uuid()
WHERE batch_id IS NULL;

UPDATE plan_day_shifts
SET created_at = now()
WHERE created_at IS NULL;

ALTER TABLE plan_day_shifts
  ALTER COLUMN batch_id SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  DROP CONSTRAINT plan_day_shifts_plan_day_id_key;

CREATE UNIQUE INDEX plan_day_shifts_plan_day_batch_uidx
  ON plan_day_shifts (plan_day_id, batch_id);

CREATE INDEX plan_day_shifts_batch_created_idx
  ON plan_day_shifts (batch_id, created_at DESC);

COMMIT;
