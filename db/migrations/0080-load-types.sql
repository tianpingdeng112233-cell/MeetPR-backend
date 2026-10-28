-- Spec 056 card A. No real database application is part of this card.
BEGIN;
SET search_path TO public;

ALTER TABLE plan_sets DROP CONSTRAINT plan_sets_load_mode_check;
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_load_mode_check CHECK (
  load_mode IS NULL OR load_mode IN (
    'pct', 'rpe', 'rir', 'weight_range', 'rpe_range', 'fixed_weight',
    'free_weight', 'bodyweight'
  )
);

ALTER TABLE plan_sets ALTER COLUMN intensity_mode DROP NOT NULL;
ALTER TABLE plan_sets ALTER COLUMN target_value DROP NOT NULL;
ALTER TABLE plan_sets DROP CONSTRAINT plan_sets_intensity_mode_check;
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_intensity_mode_check CHECK (
  intensity_mode IS NULL OR intensity_mode IN ('weight', 'rpe')
);
ALTER TABLE plan_sets DROP CONSTRAINT plan_sets_target_value_check;
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_target_value_check CHECK (
  (
    (load_mode IS NOT NULL AND load_mode IN ('free_weight', 'bodyweight')) OR
    (intensity_mode IS NOT NULL AND target_value IS NOT NULL)
  ) AND (
    intensity_mode IS NULL OR target_value IS NULL OR
    (intensity_mode = 'rpe' AND target_value BETWEEN 1.0 AND 10.0) OR
    (intensity_mode = 'weight' AND target_value > 0 AND target_value < 1000)
  )
);

-- No FK: preserve the original note even if a group is later deleted.
CREATE TABLE plan_sets_load_types_0080_backup (
  id UUID PRIMARY KEY,
  coach_note TEXT,
  load_mode TEXT
);
INSERT INTO plan_sets_load_types_0080_backup (id, coach_note, load_mode)
SELECT id, coach_note, load_mode FROM plan_sets
WHERE load_mode IS NULL
  AND intensity_mode = 'rpe' AND target_value = 10
  AND coach_note <> regexp_replace(coach_note, '(^|\s)(自重|bodyweight)(\s|$)', '\1\3', 'i')
  -- Require the entire exercise row to use the exact legacy encoding.
  -- Explicit NULL branches avoid SQL UNKNOWN admitting incomplete siblings.
  AND plan_exercise_id NOT IN (
    SELECT plan_exercise_id FROM plan_sets
    WHERE load_mode IS NOT NULL
      OR intensity_mode IS NULL OR intensity_mode <> 'rpe'
      OR target_value IS NULL OR target_value <> 10
      OR coach_note IS NULL
      OR coach_note = regexp_replace(coach_note, '(^|\s)(自重|bodyweight)(\s|$)', '\1\3', 'i')
  );

UPDATE plan_sets SET
  load_mode = 'bodyweight',
  -- Remove one standalone protocol token only; do not trim or edit free text.
  coach_note = NULLIF(regexp_replace(
    coach_note, '(^|\s)(自重|bodyweight)(\s|$)', '\1\3', 'i'
  ), '')
WHERE id IN (SELECT id FROM plan_sets_load_types_0080_backup);

COMMIT;

-- Stop new-type writers before rollback. This restores the backed-up rows
-- exactly. If additional new-type rows exist, the old constraints intentionally
-- abort the transaction; review their conversion separately, never delete them.
/* ROLLBACK
BEGIN;
SET search_path TO public;
UPDATE plan_sets SET coach_note = b.coach_note, load_mode = b.load_mode
FROM plan_sets_load_types_0080_backup AS b WHERE plan_sets.id = b.id;
ALTER TABLE plan_sets DROP CONSTRAINT plan_sets_target_value_check;
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_target_value_check CHECK (
  (intensity_mode = 'rpe' AND target_value BETWEEN 1.0 AND 10.0) OR
  (intensity_mode = 'weight' AND target_value > 0 AND target_value < 1000)
);
ALTER TABLE plan_sets ALTER COLUMN intensity_mode SET NOT NULL;
ALTER TABLE plan_sets ALTER COLUMN target_value SET NOT NULL;
ALTER TABLE plan_sets DROP CONSTRAINT plan_sets_intensity_mode_check;
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_intensity_mode_check CHECK (intensity_mode IN ('weight', 'rpe'));
ALTER TABLE plan_sets DROP CONSTRAINT plan_sets_load_mode_check;
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_load_mode_check CHECK (
  load_mode IS NULL OR load_mode IN ('pct', 'rpe', 'rir', 'weight_range', 'rpe_range', 'fixed_weight')
);
DROP TABLE plan_sets_load_types_0080_backup;
COMMIT;
*/
