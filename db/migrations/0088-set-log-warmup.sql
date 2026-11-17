-- SPEC 068: student-added warm-up sets. Existing rows remain ordinary logs.
BEGIN;
SET search_path TO public;
ALTER TABLE set_logs ADD COLUMN is_warmup BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE set_logs ADD CONSTRAINT set_logs_warmup_plan_check
  CHECK (NOT is_warmup OR (plan_exercise_id IS NOT NULL AND NOT adhoc));
COMMIT;

-- Rollback (staging rehearsal only): warm-up rows become ordinary extra sets
-- and enter statistics after dropping this marker. No rows are deleted.
-- BEGIN;
-- SET search_path TO public;
-- ALTER TABLE set_logs DROP CONSTRAINT set_logs_warmup_plan_check;
-- ALTER TABLE set_logs DROP COLUMN is_warmup;
-- COMMIT;
