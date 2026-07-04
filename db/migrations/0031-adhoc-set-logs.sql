-- Migration 0031: ad-hoc set logging (self-train Free tier).
-- set_logs learns to exist without a plan: direct exercise reference,
-- client-local logged_date, and a nullable plan link that survives plan
-- deletion (SET NULL, precedent: feedback.plan_exercise_id since 0006) so a
-- student's history is never erased by plan edits or deletion.
-- adhoc marks rows born outside any plan; orphaned plan rows stay adhoc=false
-- and are exempt from the adhoc uniqueness index.
-- Spec: specs/010-adhoc-set-logging/SPEC.md (+ iOS specs/045-solo-adhoc-logging)

BEGIN;

ALTER TABLE set_logs
  ADD COLUMN exercise_id UUID REFERENCES exercises(id),
  ADD COLUMN logged_date DATE,
  ADD COLUMN adhoc BOOLEAN NOT NULL DEFAULT FALSE;

-- Target table deliberately unaliased: the pg-mem test harness cannot
-- resolve an alias on the UPDATE target (probe 2026-07-04).
UPDATE set_logs
SET exercise_id = pe.exercise_id
FROM plan_exercises pe
WHERE pe.id = set_logs.plan_exercise_id;

-- Asia/Shanghai has been fixed UTC+8 (no DST) since 1991, so interval math is
-- exact for the whole (China-based) install base and stays portable to the
-- pg-mem test harness where AT TIME ZONE names are unsupported.
UPDATE set_logs
SET logged_date = (logged_at + INTERVAL '8 hours')::date
WHERE logged_date IS NULL;

ALTER TABLE set_logs
  ALTER COLUMN exercise_id SET NOT NULL;
ALTER TABLE set_logs
  ALTER COLUMN logged_date SET NOT NULL;
ALTER TABLE set_logs
  ALTER COLUMN plan_exercise_id DROP NOT NULL;

ALTER TABLE set_logs
  DROP CONSTRAINT set_logs_plan_exercise_id_fkey;
ALTER TABLE set_logs
  ADD CONSTRAINT set_logs_plan_exercise_id_fkey
    FOREIGN KEY (plan_exercise_id) REFERENCES plan_exercises(id) ON DELETE SET NULL;

ALTER TABLE set_logs
  ADD CONSTRAINT set_logs_adhoc_no_plan_check CHECK (NOT adhoc OR plan_exercise_id IS NULL);

CREATE UNIQUE INDEX set_logs_adhoc_unique_idx
  ON set_logs (student_id, exercise_id, logged_date, set_index)
  WHERE adhoc;

CREATE INDEX set_logs_student_exercise_idx
  ON set_logs (student_id, exercise_id, logged_at DESC);

COMMIT;

-- Rollback (staging drills only — restores the data-loss CASCADE semantics):
--   BEGIN;
--   DROP INDEX set_logs_student_exercise_idx;
--   DROP INDEX set_logs_adhoc_unique_idx;
--   ALTER TABLE set_logs DROP CONSTRAINT set_logs_adhoc_no_plan_check;
--   DELETE FROM set_logs WHERE plan_exercise_id IS NULL;
--   ALTER TABLE set_logs DROP CONSTRAINT set_logs_plan_exercise_id_fkey;
--   ALTER TABLE set_logs ADD CONSTRAINT set_logs_plan_exercise_id_fkey
--     FOREIGN KEY (plan_exercise_id) REFERENCES plan_exercises(id) ON DELETE CASCADE;
--   ALTER TABLE set_logs ALTER COLUMN plan_exercise_id SET NOT NULL;
--   ALTER TABLE set_logs DROP COLUMN adhoc;
--   ALTER TABLE set_logs DROP COLUMN logged_date;
--   ALTER TABLE set_logs DROP COLUMN exercise_id;
--   COMMIT;
