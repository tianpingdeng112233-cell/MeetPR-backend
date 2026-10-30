-- Spec 056: backfill the live old web's rpe-mode bodyweight encoding.
-- Requires 0080. No real database application is part of this task.
BEGIN;
SET search_path TO public;

-- No FK: preserve the original note even if a group is later deleted.
CREATE TABLE plan_sets_load_types_0081_backup (
  id UUID PRIMARY KEY,
  coach_note TEXT,
  load_mode TEXT,
  target_rpe NUMERIC(3,1)
);
INSERT INTO plan_sets_load_types_0081_backup (id, coach_note, load_mode, target_rpe)
SELECT id, coach_note, load_mode, target_rpe FROM plan_sets
WHERE load_mode = 'rpe' AND target_rpe = 10
  AND intensity_mode = 'rpe' AND target_value = 10
  AND coach_note <> regexp_replace(coach_note, '(^|\s)(自重|bodyweight)(\s|$)', '\1\3', 'i')
  -- Require the entire exercise row to use the exact legacy encoding.
  -- Explicit NULL branches avoid SQL UNKNOWN admitting incomplete siblings.
  AND plan_exercise_id NOT IN (
    SELECT plan_exercise_id FROM plan_sets
    WHERE load_mode IS NULL OR load_mode <> 'rpe'
      OR target_rpe IS NULL OR target_rpe <> 10
      OR intensity_mode IS NULL OR intensity_mode <> 'rpe'
      OR target_value IS NULL OR target_value <> 10
      OR coach_note IS NULL
      OR coach_note = regexp_replace(coach_note, '(^|\s)(自重|bodyweight)(\s|$)', '\1\3', 'i')
  );

UPDATE plan_sets SET
  load_mode = 'bodyweight',
  target_rpe = NULL,
  -- Remove one standalone protocol token only; do not trim or edit free text.
  coach_note = NULLIF(regexp_replace(
    coach_note, '(^|\s)(自重|bodyweight)(\s|$)', '\1\3', 'i'
  ), '')
WHERE id IN (SELECT id FROM plan_sets_load_types_0081_backup);

COMMIT;

-- Stop old-web writers before rollback. Restore the backed-up fields exactly;
-- rows deleted since migration stay deleted. Keep 0080's schema and backup.
/* ROLLBACK
BEGIN;
SET search_path TO public;
UPDATE plan_sets SET
  coach_note = b.coach_note,
  load_mode = b.load_mode,
  target_rpe = b.target_rpe
FROM plan_sets_load_types_0081_backup AS b WHERE plan_sets.id = b.id;
DROP TABLE plan_sets_load_types_0081_backup;
COMMIT;
*/
