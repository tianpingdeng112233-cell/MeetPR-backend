-- Migration 0025: mirror the iOS catalog data corrections (MeetPR PR #193) into
-- the backend exercises catalog, so /exercises and the web editor stay aligned.
--   #1 Add 2 squat main-lift variations (ids ca71-…0010/0011), mirroring 低杠位深蹲.
--   #3 Rename 9 deadlift exercises RDL/罗拉 → 罗马尼亚硬拉 (name only; ids and
--      name_en unchanged so plan_exercises.exercise_id FKs stay valid).
-- Renumbered 0023->0025 to sit after PR #30's 0023+0024 (avoids the 0023 collision).
-- Mirrors exercise-catalog-v2.json
-- for these ids (created_at uses the column default per the 0002.1 generator convention).
-- Idempotent: ON CONFLICT (id) upsert + UPDATE-by-id are safe to re-run.
-- Source: MeetPR/Modules/CoachKit/Sources/CoachKit/Resources/exercise-catalog-v2.json

BEGIN;

-- #1 — two low-bar squat variations (fields mirror 低杠位深蹲).
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
  ('00000000-0000-0000-ca71-000000000010'::UUID, '低杠位暂停深蹲', 'Low Bar Paused Squat', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['squat']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000011'::UUID, '低杠位节奏深蹲', 'Low Bar Tempo Squat', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['squat']::TEXT[])
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

-- #3 — rename RDL/罗拉 → 罗马尼亚硬拉 (name only; name_en keeps the RDL abbreviation).
UPDATE exercises SET name = '弹力带绕髋罗马尼亚硬拉'      WHERE id = '00000000-0000-0000-ca70-000000000048'::UUID;
UPDATE exercises SET name = '抓举握距罗马尼亚硬拉'        WHERE id = '00000000-0000-0000-ca70-000000000049'::UUID;
UPDATE exercises SET name = '前后站单腿罗马尼亚硬拉'      WHERE id = '00000000-0000-0000-ca70-00000000004a'::UUID;
UPDATE exercises SET name = '相扑罗马尼亚硬拉'           WHERE id = '00000000-0000-0000-ca70-00000000004b'::UUID;
UPDATE exercises SET name = '节奏罗马尼亚硬拉'           WHERE id = '00000000-0000-0000-ca70-00000000004d'::UUID;
UPDATE exercises SET name = '单腿罗马尼亚硬拉'           WHERE id = '00000000-0000-0000-ca70-000000000108'::UUID;
UPDATE exercises SET name = '单腿罗马尼亚硬拉(纯单腿)'    WHERE id = '00000000-0000-0000-ca70-000000000109'::UUID;
UPDATE exercises SET name = 'B 站距罗马尼亚硬拉'         WHERE id = '00000000-0000-0000-ca70-00000000012c'::UUID;
UPDATE exercises SET name = '单腿罗马尼亚硬拉(B 站距)'    WHERE id = '00000000-0000-0000-ca70-00000000012d'::UUID;

COMMIT;
