-- Migration 0019: sync exercises catalog with the iOS plan-coverage updates
-- (2026-06-24, from the 吕子豪 / 邓天平 / 许可 plan audit). Catalog follow-up to
-- 0002.1; numbered 0019 (next after the current 0018 head). Must run after 0003
-- because the duplicate-merge re-points plan_exercises (a table 0003 creates)
-- before deleting. Mirrors exercise-catalog-v2.json:
--   * adds 15 new exercises (ids ca71-…0001..000f),
--   * renames 13 existing entries (12 name-only + 保加利亚分腿蹲(自重), which is
--     also re-equipped to bodyweight),
--   * removes 2 entries merged into a surviving spelling.
-- Idempotent: ON CONFLICT upsert + id-keyed UPDATE/DELETE make it safe to re-run.
-- Source: MeetPR/Modules/CoachKit/Sources/CoachKit/Resources/exercise-catalog-v2.json

BEGIN;

-- 1. New exercises.
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
  ('00000000-0000-0000-ca71-000000000001'::UUID, '低杠位深蹲', 'Low Bar Squat', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['squat']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000002'::UUID, '噩梦硬拉', 'Nightmare Deadlift', 'main_lift_variation', 'deadlift', FALSE, ARRAY['hamstring']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000003'::UUID, '大猩猩蹲', 'Gorilla Squat', 'accessory', NULL, FALSE, ARRAY['hamstring']::TEXT[], ARRAY['bodyweight']::TEXT[], ARRAY['warm_up']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000004'::UUID, '髋部飞机', 'Hip Airplane', 'accessory', NULL, FALSE, ARRAY['glute']::TEXT[], ARRAY['bodyweight']::TEXT[], ARRAY['warm_up']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000005'::UUID, '低杆位早安式', 'Low Bar Good Morning', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['squat']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000006'::UUID, '安全杆早安式', 'Safety Bar Good Morning', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['specialty_bar']::TEXT[], ARRAY['squat']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000007'::UUID, '无腰带低杆位早安式', 'Beltless Low Bar Good Morning', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['squat']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000008'::UUID, 'PIN低杆位早安式', 'Pin Low Bar Good Morning', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['squat']::TEXT[]),
  ('00000000-0000-0000-ca71-000000000009'::UUID, '杠铃保加利亚深蹲', 'Barbell Bulgarian Split Squat', 'accessory', NULL, FALSE, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['other']::TEXT[]),
  ('00000000-0000-0000-ca71-00000000000a'::UUID, 'spoto 暂停卧推', 'Spoto Paused Press', 'main_lift_variation', 'bench', FALSE, ARRAY['chest']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
  ('00000000-0000-0000-ca71-00000000000b'::UUID, '超程(赤字)相扑', 'Deficit Sumo Deadlift', 'main_lift_variation', 'deadlift', FALSE, ARRAY['hamstring']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
  ('00000000-0000-0000-ca71-00000000000c'::UUID, '相扑节奏硬拉', 'Tempo Sumo Deadlift', 'main_lift_variation', 'deadlift', FALSE, ARRAY['hamstring']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
  ('00000000-0000-0000-ca71-00000000000d'::UUID, '澳大利亚引体', 'Australian Pull-up', 'accessory', NULL, FALSE, ARRAY['back']::TEXT[], ARRAY['bodyweight']::TEXT[], ARRAY['horizontal_pull']::TEXT[]),
  ('00000000-0000-0000-ca71-00000000000e'::UUID, '臀推', 'Barbell Hip Thrust', 'accessory', NULL, FALSE, ARRAY['glute']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
  ('00000000-0000-0000-ca71-00000000000f'::UUID, '曲杆上提', 'EZ-Bar Upright Row', 'accessory', NULL, FALSE, ARRAY['shoulder']::TEXT[], ARRAY['specialty_bar']::TEXT[], ARRAY['other']::TEXT[])
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

-- 2. Renames (display name only; ids unchanged so plan references are intact).
UPDATE exercises SET name = 'SSB(安全杆)深蹲' WHERE id = '00000000-0000-0000-ca70-00000000001f'::UUID;
UPDATE exercises SET name = '架上(PIN)深蹲' WHERE id = '00000000-0000-0000-ca70-00000000000b'::UUID;
UPDATE exercises SET name = '架上(PIN)卧推' WHERE id = '00000000-0000-0000-ca70-00000000005f'::UUID;
UPDATE exercises SET name = '传统节奏硬拉' WHERE id = '00000000-0000-0000-ca70-00000000003e'::UUID;
UPDATE exercises SET name = '实力推' WHERE id = '00000000-0000-0000-ca70-0000000002fa'::UUID;
UPDATE exercises SET name = '坐姿 v 把划船' WHERE id = '00000000-0000-0000-ca70-00000000023d'::UUID;
UPDATE exercises SET name = '水平划船' WHERE id = '00000000-0000-0000-ca70-00000000026b'::UUID;
UPDATE exercises SET name = '绳索三头下压' WHERE id = '00000000-0000-0000-ca70-00000000038a'::UUID;
UPDATE exercises SET name = '绳索面拉' WHERE id = '00000000-0000-0000-ca70-000000000074'::UUID;
UPDATE exercises SET name = '哑铃保加利亚深蹲' WHERE id = '00000000-0000-0000-ca70-0000000000f6'::UUID;
UPDATE exercises SET name = '弹力带螃蟹步' WHERE id = '00000000-0000-0000-ca70-000000000185'::UUID;
UPDATE exercises SET name = '熊爬交替换手' WHERE id = '00000000-0000-0000-ca70-000000000199'::UUID;

-- Relabel the bodyweight Bulgarian split squat and align its equipment with the name
-- (dumbbell / barbell variants are the new ca71-…0009 entry + 哑铃保加利亚深蹲).
UPDATE exercises
SET name = '保加利亚分腿蹲(自重)',
    name_en = 'Bodyweight Bulgarian Split Squat',
    equipment = ARRAY['bodyweight']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-0000000000f5'::UUID;

-- 3. Merge duplicates into the surviving spelling (弹力带螃蟹步 / 熊爬交替换手).
-- First re-point any plans that referenced the merged-away exercises onto the
-- survivors: plan_exercises.exercise_id is ON DELETE RESTRICT, so a lingering
-- reference would make the DELETE (and the whole migration) fail. There is no
-- UNIQUE (plan_day_id, exercise_id), so re-pointing can't collide.
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000185'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-00000000019e'::UUID;  -- 螃蟹步 → 弹力带螃蟹步
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000199'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000179'::UUID;  -- 熊爬肩部触摸 → 熊爬交替换手

DELETE FROM exercises WHERE id IN (
  '00000000-0000-0000-ca70-00000000019e'::UUID,
  '00000000-0000-0000-ca70-000000000179'::UUID
);

COMMIT;
