-- Migration 0069: apply the catalog classification audit approved on 2026-08-23.
-- Source: /Users/david/Projects/scratch/catalog-classification-audit-2026-08-23.md
-- Merge direction table (loser -> winner):
--   ca70-00000000011e (早安) -> ca70-000000000022 (早安式)
--   ca70-0000000002f0 (六角杠深蹲) -> ca70-000000000051 (六角杠硬拉)
--   ca70-00000000029f (杰弗森深蹲) -> ca70-000000000032 (杰弗森硬拉)
--   ca70-0000000001b6 (抬腿杠铃卧推) -> ca70-00000000005b (无腿卧推)
--   ca70-000000000053 (弹力带杠铃卧推) -> ca71-000000000014 (弹力带卧推)
--   ca70-0000000001f2 (弹力绳-卧推) -> ca71-000000000014 (弹力带卧推)
--   ca70-000000000011 (背蹲地面起始设置) -> ca70-00000000000f (Anderson 深蹲)
--   ca70-000000000280 (澳式引体) -> ca71-00000000000d (澳大利亚引体)
--   ca70-0000000003e7 (壶铃甩) -> ca70-000000000129 (壶铃摆动)
--   ca70-0000000002a0 (杠铃火箭推) -> ca70-000000000169 (借力推举)
-- iOS 捆绑 exercise-catalog-v2.json 需另卡同步。

BEGIN;
SET search_path TO public;

-- Guard every unique merge winner (and every §1 classification target) before any write. As in migration 0056,
-- zero/multiple matches collapse CASE to NULL and the NOT NULL constraint
-- aborts the entire transaction instead of silently no-opping.
CREATE TABLE _0069_winner_exists (id UUID NOT NULL);

-- 早安式 (winner)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000022'::UUID
  AND name = '早安式';

-- 六角杆硬拉 / 六角杠硬拉 (winner; migration renames it)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000051'::UUID
  AND name IN ('六角杆硬拉', '六角杠硬拉');

-- Jefferson 硬拉 / 杰弗森硬拉 (winner; migration renames it)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000032'::UUID
  AND name IN ('Jefferson 硬拉', '杰弗森硬拉');

-- 无腿卧推 (winner)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-00000000005b'::UUID
  AND name = '无腿卧推';

-- 弹力带卧推 (winner; ca71 prefix)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca71-000000000014'::UUID
  AND name = '弹力带卧推';

-- Anderson 深蹲 (winner)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-00000000000f'::UUID
  AND name = 'Anderson 深蹲';

-- 澳大利亚引体 (winner; ca71 prefix)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca71-00000000000d'::UUID
  AND name = '澳大利亚引体';

-- 壶铃摆动 (winner)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000129'::UUID
  AND name = '壶铃摆动';

-- 借力推举 (winner)
INSERT INTO _0069_winner_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000169'::UUID
  AND name = '借力推举';

-- Classification targets (§1) are guarded the same way: a missing row or an
-- id that no longer carries the expected name aborts instead of no-opping.
CREATE TABLE _0069_target_exists (id UUID NOT NULL);

-- 窄距卧推(敞开式)
INSERT INTO _0069_target_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000372'::UUID
  AND name = '窄距卧推(敞开式)';

-- 窄距卧推(靠近式)
INSERT INTO _0069_target_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000373'::UUID
  AND name = '窄距卧推(靠近式)';

-- 杠铃深蹲
INSERT INTO _0069_target_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-00000000029e'::UUID
  AND name = '杠铃深蹲';

-- 粗杠硬拉
INSERT INTO _0069_target_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000156'::UUID
  AND name = '粗杠硬拉';

-- 深蹲跳
INSERT INTO _0069_target_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000021'::UUID
  AND name = '深蹲跳';

-- Classification promotions/demotion. Type and family move together to keep
-- exercises_main_lift_family_consistency valid after every statement.

-- 窄距卧推(敞开式)
UPDATE exercises
SET exercise_type = 'main_lift_variation', main_lift_family = 'bench'
WHERE id = '00000000-0000-0000-ca70-000000000372'::UUID;

-- 窄距卧推(靠近式)
UPDATE exercises
SET exercise_type = 'main_lift_variation', main_lift_family = 'bench'
WHERE id = '00000000-0000-0000-ca70-000000000373'::UUID;

-- 杠铃深蹲
UPDATE exercises
SET exercise_type = 'main_lift_variation', main_lift_family = 'squat'
WHERE id = '00000000-0000-0000-ca70-00000000029e'::UUID;

-- 粗杠硬拉
UPDATE exercises
SET exercise_type = 'main_lift_variation',
    main_lift_family = 'deadlift',
    muscle_groups = ARRAY['hamstring', 'glute', 'back']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000156'::UUID;

-- 深蹲跳
UPDATE exercises
SET exercise_type = 'accessory', main_lift_family = NULL
WHERE id = '00000000-0000-0000-ca70-000000000021'::UUID;

-- Merge 1: 早安 -> 早安式.
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000022'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-00000000011e'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca70-000000000022'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-00000000011e'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca70-000000000022'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-00000000011e'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-00000000011e'::UUID AND created_by_coach_id IS NULL;

-- Merge 2: 六角杠深蹲 -> 六角杆硬拉 (renamed 六角杠硬拉 below).
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000051'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000002f0'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca70-000000000051'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000002f0'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca70-000000000051'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-0000000002f0'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-0000000002f0'::UUID AND created_by_coach_id IS NULL;

-- Merge 3: 杰弗森深蹲 -> Jefferson 硬拉 (renamed 杰弗森硬拉 below).
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000032'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-00000000029f'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca70-000000000032'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-00000000029f'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca70-000000000032'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-00000000029f'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-00000000029f'::UUID AND created_by_coach_id IS NULL;

-- Merge 4: 抬腿杠铃卧推 -> 无腿卧推.
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-00000000005b'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000001b6'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca70-00000000005b'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000001b6'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca70-00000000005b'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-0000000001b6'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-0000000001b6'::UUID AND created_by_coach_id IS NULL;

-- Merge 5: 弹力带杠铃卧推 (ca70) -> 弹力带卧推 (ca71).
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca71-000000000014'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000053'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca71-000000000014'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000053'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca71-000000000014'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-000000000053'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000053'::UUID AND created_by_coach_id IS NULL;

-- Merge 6: 弹力绳-卧推 (ca70) -> 弹力带卧推 (ca71).
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca71-000000000014'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000001f2'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca71-000000000014'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000001f2'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca71-000000000014'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-0000000001f2'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-0000000001f2'::UUID AND created_by_coach_id IS NULL;

-- Merge 7: 背蹲地面起始设置 -> Anderson 深蹲.
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-00000000000f'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000011'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca70-00000000000f'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000011'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca70-00000000000f'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-000000000011'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000011'::UUID AND created_by_coach_id IS NULL;

-- Merge 8: 澳式引体 (ca70) -> 澳大利亚引体 (ca71).
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca71-00000000000d'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000280'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca71-00000000000d'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000280'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca71-00000000000d'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-000000000280'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-000000000280'::UUID AND created_by_coach_id IS NULL;

-- Merge 9: 壶铃甩 -> 壶铃摆动.
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000129'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000003e7'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca70-000000000129'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000003e7'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca70-000000000129'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-0000000003e7'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-0000000003e7'::UUID AND created_by_coach_id IS NULL;

-- Merge 10: 杠铃火箭推 -> 借力推举.
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000169'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000002a0'::UUID;
UPDATE set_logs SET exercise_id = '00000000-0000-0000-ca70-000000000169'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000002a0'::UUID;
UPDATE exercises SET base_exercise_id = '00000000-0000-0000-ca70-000000000169'::UUID
WHERE base_exercise_id = '00000000-0000-0000-ca70-0000000002a0'::UUID;
DELETE FROM exercises
WHERE id = '00000000-0000-0000-ca70-0000000002a0'::UUID AND created_by_coach_id IS NULL;

-- Winner display-name corrections.
UPDATE exercises SET name = '六角杠硬拉'
WHERE id = '00000000-0000-0000-ca70-000000000051'::UUID; -- 六角杆硬拉
UPDATE exercises SET name = '杰弗森硬拉'
WHERE id = '00000000-0000-0000-ca70-000000000032'::UUID; -- Jefferson 硬拉

-- Muscle-group corrections.
UPDATE exercises SET muscle_groups = ARRAY['hamstring', 'glute']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000004d'::UUID; -- 节奏罗马尼亚硬拉
UPDATE exercises SET muscle_groups = ARRAY['quad']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000000c'::UUID; -- 节奏插销深蹲（架上）
UPDATE exercises SET muscle_groups = ARRAY['quad', 'glute']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-0000000000e5'::UUID; -- 节奏高脚杯深蹲
UPDATE exercises SET muscle_groups = ARRAY['hamstring', 'glute', 'back']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000022'::UUID; -- 早安式
UPDATE exercises SET muscle_groups = ARRAY['hamstring', 'glute', 'back']::TEXT[]
WHERE id = '00000000-0000-0000-ca71-000000000005'::UUID; -- 低杆位早安式
UPDATE exercises SET muscle_groups = ARRAY['hamstring', 'glute', 'back']::TEXT[]
WHERE id = '00000000-0000-0000-ca71-000000000006'::UUID; -- 安全杆早安式
UPDATE exercises SET muscle_groups = ARRAY['hamstring', 'glute', 'back']::TEXT[]
WHERE id = '00000000-0000-0000-ca71-000000000007'::UUID; -- 无腰带低杆位早安式
UPDATE exercises SET muscle_groups = ARRAY['hamstring', 'glute', 'back']::TEXT[]
WHERE id = '00000000-0000-0000-ca71-000000000008'::UUID; -- PIN低杆位早安式
UPDATE exercises SET muscle_groups = ARRAY['quad', 'glute', 'hamstring']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000032'::UUID; -- 杰弗森硬拉

-- Equipment corrections.
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000054'::UUID; -- 弹力带中握卧推
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000006b'::UUID; -- 弹力带拉森卧推
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000002b'::UUID; -- 弹力带硬拉
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000005'::UUID; -- 弹力带前蹲
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000001c'::UUID; -- 弹力带辅助深蹲
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000038'::UUID; -- 弹力带辅助传统硬拉
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000039'::UUID; -- 弹力带辅助相扑硬拉
UPDATE exercises SET equipment = ARRAY['barbell', 'band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000048'::UUID; -- 弹力带绕髋罗马尼亚硬拉
UPDATE exercises SET equipment = ARRAY['band', 'cable']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000141'::UUID; -- 弹力带 pallof 推
UPDATE exercises SET equipment = ARRAY['band']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000172'::UUID; -- 弹力带抗阻腘绳肌
UPDATE exercises SET equipment = ARRAY['specialty_bar']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000009'::UUID; -- 扶手安全杆暂停深蹲
UPDATE exercises SET equipment = ARRAY['specialty_bar']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000000a'::UUID; -- 扶手安全杆深蹲
UPDATE exercises SET equipment = ARRAY['barbell']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000077'::UUID; -- 地雷推
UPDATE exercises SET equipment = ARRAY['barbell']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000007d'::UUID; -- 坐姿杠铃推举
UPDATE exercises SET equipment = ARRAY['barbell']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000085'::UUID; -- 杠铃直立划船
UPDATE exercises SET equipment = ARRAY['cable']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000074'::UUID; -- 绳索面拉
UPDATE exercises SET equipment = ARRAY['cable']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000012b'::UUID; -- 绳索穿裆拉
UPDATE exercises SET equipment = ARRAY['dumbbell', 'kettlebell']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-0000000000e4'::UUID; -- 哑铃酒杯深蹲
UPDATE exercises SET equipment = ARRAY['dumbbell']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000113'::UUID; -- 哑铃侧弓步
UPDATE exercises SET equipment = ARRAY['dumbbell']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000190'::UUID; -- 站姿哑铃肩部环绕
UPDATE exercises SET equipment = ARRAY['dumbbell']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-00000000036b'::UUID; -- 健身球牧师哑铃弯举

DROP TABLE _0069_target_exists;
DROP TABLE _0069_winner_exists;

COMMIT;
