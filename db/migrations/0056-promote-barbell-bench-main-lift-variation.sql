-- Migration 0056: promote 杠铃卧推 from accessory to a bench main-lift variation.
-- 拍板 2026-08-01: 竞技卧推与杠铃卧推两条都保留——竞技卧推仍是唯一比赛卧推
-- (main_lift/is_competition_lift 不动), 杠铃卧推(00000000-0000-0000-ca70-0000000001b4,
-- 0002.1 从 catalog v2 播种时误标 accessory/chest) 升为 main_lift_variation/bench,
-- 从而进入主项及变式口径(plan-web 导入 isMain、iOS 主项选择器、统计)。
-- 其余字段(name/name_en/muscle_groups/equipment/movement_pattern)不动; 引用无需迁移,
-- id 不变。

BEGIN;

-- Assert the target row exists (and is still the expected 杠铃卧推) before writing:
-- zero rows collapse the CASE to NULL and the NOT NULL constraint aborts the
-- migration instead of silently no-opping.
CREATE TABLE _0056_target_exists (id UUID NOT NULL);
INSERT INTO _0056_target_exists (id)
SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::TEXT)::UUID END
FROM exercises
WHERE id = '00000000-0000-0000-ca70-0000000001b4'::UUID
  AND name = '杠铃卧推';

UPDATE exercises
SET exercise_type = 'main_lift_variation',
    main_lift_family = 'bench'
WHERE id = '00000000-0000-0000-ca70-0000000001b4'::UUID;

DROP TABLE _0056_target_exists;

COMMIT;
