-- Migration 0034: retain imported plan history and mark assumed set logs.

BEGIN;

ALTER TABLE set_logs
  DROP CONSTRAINT set_logs_plan_exercise_id_fkey;

ALTER TABLE set_logs
  ADD CONSTRAINT set_logs_plan_exercise_id_fkey
  FOREIGN KEY (plan_exercise_id) REFERENCES plan_exercises(id) ON DELETE RESTRICT;

ALTER TABLE set_logs
  ADD COLUMN assumed BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
