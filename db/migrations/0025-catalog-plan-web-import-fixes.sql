-- Migration 0025: catalog fixes surfaced by the meetpr-plan-web xlsx import coverage
-- audit (2026-07-02). Coaches' handwritten exercise names failed to bind because the
-- catalog either used a different name or lacked the exercise. Renames keep the id
-- (and name_en) stable so plan_exercises.exercise_id FKs stay valid.
--   Rename #1: 哑铃推肩 → 哑铃坐姿推肩   (id ca70-…007f)  — match coach wording.
--   Rename #2: 颈后下拉 → 颈后高位下拉   (id ca70-…00a4)  — match coach wording.
--   Delete:    宽距高位下拉             (id ca70-…0231)  — 0 plan_exercises refs
--              (verified against prod before writing); superseded by the 宽握 variants.
--   Add 4:     坐姿宽握距划船 / 节奏窄握卧推 / 弹力带卧推 / 宽握距罗马尼亚硬拉
--              (ids ca71-…0012‥0015 — continues the 0023 ca71 manual-add range,
--               skipping 0010/0011 reserved by 0023's squat variations).
-- 架上(PIN)深蹲 already exists (ca70-…000b); no catalog change, only a web alias.
-- Idempotent: rename-by-id / delete-by-id / ON CONFLICT (id) upsert are all re-run safe,
-- so this is orthogonal to the pending 0023 RDL rename and can land on prod in any order.
-- Mirrors MeetPR/Modules/CoachKit/Sources/CoachKit/Resources/exercise-catalog-v2.json.
-- Source: meetpr-plan-web import binding audit; catalog decisions by David 2026-07-02.

BEGIN;

-- Renames (name only; id + name_en unchanged).
UPDATE exercises SET name = '哑铃坐姿推肩' WHERE id = '00000000-0000-0000-ca70-00000000007f'::UUID;
UPDATE exercises SET name = '颈后高位下拉' WHERE id = '00000000-0000-0000-ca70-0000000000a4'::UUID;

-- Delete an unreferenced, superseded variation.
DELETE FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000231'::UUID;

-- Add 4 exercises coaches write but the catalog lacked (fields mirror the closest analog).
INSERT INTO exercises (
  id,
  name,
  name_en,
  exercise_type,
  main_lift_family,
  is_competition_lift,
  muscle_groups,
  equipment,
  movement_pattern
) VALUES
  ('00000000-0000-0000-ca71-000000000012'::UUID, '坐姿宽握距划船',       'Seated Wide Grip Row',          'accessory',            NULL,       FALSE, ARRAY['back']::TEXT[],      ARRAY['cable']::TEXT[],            ARRAY['horizontal_pull']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000013'::UUID, '节奏窄握卧推',         'Tempo Close Grip Bench Press',  'main_lift_variation',  'bench',    FALSE, ARRAY['chest']::TEXT[],     ARRAY['barbell']::TEXT[],          ARRAY['horizontal_push']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000014'::UUID, '弹力带卧推',           'Banded Bench Press',            'main_lift_variation',  'bench',    FALSE, ARRAY['chest']::TEXT[],     ARRAY['barbell', 'band']::TEXT[],  ARRAY['horizontal_push']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000015'::UUID, '宽握距罗马尼亚硬拉',   'Wide Grip RDL',                 'main_lift_variation',  'deadlift', FALSE, ARRAY['hamstring']::TEXT[], ARRAY['barbell']::TEXT[],          ARRAY['hip_hinge']::TEXT[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  name_en = EXCLUDED.name_en,
  exercise_type = EXCLUDED.exercise_type,
  main_lift_family = EXCLUDED.main_lift_family,
  is_competition_lift = EXCLUDED.is_competition_lift,
  muscle_groups = EXCLUDED.muscle_groups,
  equipment = EXCLUDED.equipment,
  movement_pattern = EXCLUDED.movement_pattern,
  created_by_coach_id = NULL;

COMMIT;
