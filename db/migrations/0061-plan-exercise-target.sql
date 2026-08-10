-- spec 037 v1.1: coach-chosen target label for the week-band editor's 目标 column.
-- Nullable free token: 'squat'|'bench'|'deadlift' or a catalog muscle-group
-- token; NULL = no target (default). App layer validates the token shape.
BEGIN;
SET search_path TO public;

ALTER TABLE plan_exercises ADD COLUMN target TEXT;

ALTER TABLE plan_exercises ADD CONSTRAINT plan_exercises_target_check CHECK (
  target IS NULL OR length(target) BETWEEN 1 AND 32
);

COMMIT;
