-- Migration 0047: wire the readiness `energy` scale and expand muscle-fatigue
-- severity from 1-3 to 1-4.
--
-- 产品五档量表里「完全无酸痛」由「不记录该肌群」表示(与现有行为一致),
-- 因此只有其余四档需要分值:1 轻微 / 2 中等 / 3 明显 / 4 严重。severity 的
-- 方向不变,仍是越大越酸痛——与 sleep_quality / mood / stress / energy 的
-- 「越大越好」相反,这是刻意的:那四档量的是状态,这一档量的是严重度。
--
-- Spec: specs/006-readiness/SPEC.md (authority: iOS spec 030 §C7).

BEGIN;

-- 旧三档 轻/中/重 → 新四档:1→1、2→2 恒等,只有 3(重)→4(严重)真正改值。
-- 旧的最高档表达的是学员当时能表达的最强不适,降级到「明显」会丢失强度。
--
-- 版本列的必要性:映射后 3 这个值仍然合法(新数据可以写「明显」),所以
-- 「表里还有没有 severity=3」不能用来判断是否已迁移。staging 演练会重跑,
-- 没有版本标记就会把新写入的 3 误升成 4。
ALTER TABLE readiness_checkins
  ADD COLUMN IF NOT EXISTS muscle_fatigue_scale_version SMALLINT NOT NULL DEFAULT 3
    CHECK (muscle_fatigue_scale_version IN (3, 4));

-- muscle_fatigue 是对象数组,故在其 JSONB 文本形态上整体替换 severity 键。
-- 同时处理 PostgreSQL 带空格的 JSONB 文本与 pg-mem 可能产生的紧凑文本。
UPDATE readiness_checkins
SET
  muscle_fatigue = REPLACE(
    REPLACE(muscle_fatigue::TEXT, '"severity": 3', '"severity": 4'),
    '"severity":3',
    '"severity":4'
  )::JSONB,
  muscle_fatigue_scale_version = 4
WHERE muscle_fatigue_scale_version = 3;

ALTER TABLE readiness_checkins
  ALTER COLUMN muscle_fatigue_scale_version SET DEFAULT 4;

COMMIT;

-- Rollback (staging drills only):
--   BEGIN;
--   UPDATE readiness_checkins
--   SET muscle_fatigue = REPLACE(
--     REPLACE(muscle_fatigue::TEXT, '"severity": 4', '"severity": 3'),
--     '"severity":4',
--     '"severity":3'
--   )::JSONB
--   WHERE muscle_fatigue_scale_version = 4;
--   ALTER TABLE readiness_checkins DROP COLUMN muscle_fatigue_scale_version;
--   COMMIT;
