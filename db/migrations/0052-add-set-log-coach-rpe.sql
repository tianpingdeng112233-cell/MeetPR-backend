BEGIN;

SET search_path TO public;

ALTER TABLE set_logs
  ADD COLUMN coach_rpe NUMERIC(3,1) NULL;

ALTER TABLE set_logs
  ADD CONSTRAINT set_logs_coach_rpe_check
  CHECK (coach_rpe >= 0 AND coach_rpe <= 10);

COMMIT;
