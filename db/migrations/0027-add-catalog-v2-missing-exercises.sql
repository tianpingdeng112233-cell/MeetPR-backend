-- Migration 0027: add exercises present in iOS exercise-catalog-v2 but missing
-- from the deployed catalog (post-0002.1 drift). Idempotent: ON CONFLICT DO NOTHING.
-- Source: Modules/CoachKit/Sources/CoachKit/Resources/exercise-catalog-v2.json
-- Count: 18 exercises (e.g. 低杠位深蹲, 臀推, 离心卧推).
-- NOTE: this catalog content was applied directly to prod RDS on 2026-06-25, ahead of
-- this repo record. Renumbered 0024 -> 0027 on 2026-07-03 (#33/#34 took 0024/0025).
-- Idempotent, so re-running against any DB — including prod — is a safe no-op.

BEGIN;

INSERT INTO exercises (
  id, name, name_en, exercise_type, main_lift_family,
  is_competition_lift, muscle_groups, equipment, movement_pattern
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
  ('00000000-0000-0000-ca71-00000000000f'::UUID, '曲杆上提', 'EZ-Bar Upright Row', 'accessory', NULL, FALSE, ARRAY['shoulder']::TEXT[], ARRAY['specialty_bar']::TEXT[], ARRAY['other']::TEXT[]),
  ('00000000-0000-0000-ca70-0000000004dd'::UUID, '离心卧推', 'Eccentric Bench Press', 'main_lift_variation', 'bench', FALSE, ARRAY['chest']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
  ('00000000-0000-0000-ca70-0000000004de'::UUID, '弹力带窄推', 'Banded Close-Grip Bench Press', 'main_lift_variation', 'bench', FALSE, ARRAY['chest']::TEXT[], ARRAY['barbell', 'band']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
  ('00000000-0000-0000-ca70-0000000004df'::UUID, '安全杠节奏深蹲', 'Safety Bar Tempo Squat', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['specialty_bar']::TEXT[], ARRAY['squat']::TEXT[])
ON CONFLICT (id) DO NOTHING;

COMMIT;
