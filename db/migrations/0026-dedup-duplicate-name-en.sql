-- Migration 0026: de-duplicate 10 exercises that shared a nameEn with a surviving
-- spelling. Each pair was one real movement entered under two catalog ids, which split
-- a student's e1RM history across two lines. Mirrors the iOS catalog dedup
-- (exercise-catalog-v2.json 1229→1219) + alias-table additions (exercise-aliases.json
-- 34→44, each merged-away 中文名 now points at the survivor's canonical name).
-- Numbered 0026: the concurrent 0025 (web-import catalog fixes, backend PR #34) already
-- claims 0025. This migration is data-independent from 0025, so merge order is free.
--
-- Re-point any plan that referenced a merged-away exercise onto the survivor FIRST:
-- plan_exercises.exercise_id is ON DELETE RESTRICT, so a lingering reference would make
-- the DELETE (and the whole migration) fail. There is no UNIQUE (plan_day_id,
-- exercise_id), so re-pointing can't collide. set_logs / plan_sets hang off
-- plan_exercises(id), so they follow the re-point automatically and each nameEn's e1RM
-- history collapses onto one id.
--
-- Survivor chosen (David 2026-07-02) by the more accurate/complete equipment &
-- muscleGroups labeling, or the spelling that matches nameEn. Idempotent: id-keyed
-- UPDATE/DELETE become no-ops once the merge has run.
-- Source: MeetPR/Modules/CoachKit/Sources/CoachKit/Resources/exercise-catalog-v2.json

BEGIN;

-- 1. Re-point plan references: merged-away id → survivor id.
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca71-00000000000b'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000031'::UUID;  -- 相扑站高 (下陷)硬拉 → 超程(赤字)相扑 (Deficit Sumo Deadlift)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-00000000008b'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000001ca'::UUID;  -- 绳索十字夹胸 → 绳索交叉 (Cable Crossover)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-00000000008e'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000001cb'::UUID;  -- 绳索夹胸 → 绳索飞鸟 (Cable Fly)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-0000000001df'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000095'::UUID;  -- 器械胸推 → 器械推胸 (Machine Chest Press, chest+triceps)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000221'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000000b4'::UUID;  -- 彭德雷划船（潘德雷） → 潘德雷划船 (Pendlay Row, equipment=barbell)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-0000000002b6'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000000f1'::UUID;  -- 摆锤深蹲 → 钟摆深蹲 (Pendulum Squat, quad+glute)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000125'::UUID
WHERE exercise_id = '00000000-0000-0000-ca71-00000000000e'::UUID;  -- 臀推 → 杠铃臀冲 (Barbell Hip Thrust)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-00000000027b'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-000000000270'::UUID;  -- 弹力绳-坐姿划船 → 弹力带坐姿划船 (Band Seated Row)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-000000000413'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-0000000002d6'::UUID;  -- 弹力带-腿外展 → 弹力带髋外展 (Band Hip Abduction, muscle=glute)
UPDATE plan_exercises SET exercise_id = '00000000-0000-0000-ca70-00000000020b'::UUID
WHERE exercise_id = '00000000-0000-0000-ca70-00000000020c'::UUID;  -- 单侧射手俯卧撑 → 射手俯卧撑 (Archer Push-Up)

-- 2. Remove the merged-away duplicates now that nothing references them.
DELETE FROM exercises WHERE id IN (
  '00000000-0000-0000-ca70-000000000031'::UUID,  -- 相扑站高 (下陷)硬拉
  '00000000-0000-0000-ca70-0000000001ca'::UUID,  -- 绳索十字夹胸
  '00000000-0000-0000-ca70-0000000001cb'::UUID,  -- 绳索夹胸
  '00000000-0000-0000-ca70-000000000095'::UUID,  -- 器械胸推
  '00000000-0000-0000-ca70-0000000000b4'::UUID,  -- 彭德雷划船（潘德雷）
  '00000000-0000-0000-ca70-0000000000f1'::UUID,  -- 摆锤深蹲
  '00000000-0000-0000-ca71-00000000000e'::UUID,  -- 臀推
  '00000000-0000-0000-ca70-000000000270'::UUID,  -- 弹力绳-坐姿划船
  '00000000-0000-0000-ca70-0000000002d6'::UUID,  -- 弹力带-腿外展
  '00000000-0000-0000-ca70-00000000020c'::UUID   -- 单侧射手俯卧撑
);

COMMIT;
