-- 学员自加动作的训练日归属；额外组继续使用 plan_exercise_id。
-- 纯新增可空列，存量行保持 NULL；删除训练日只脱钩，不删除训练记录。
BEGIN;
SET search_path TO public;

ALTER TABLE set_logs
  ADD COLUMN IF NOT EXISTS plan_day_id UUID NULL
    REFERENCES plan_days(id) ON DELETE SET NULL;

ALTER TABLE set_logs DROP CONSTRAINT IF EXISTS set_logs_plan_day_adhoc_check;
ALTER TABLE set_logs
  ADD CONSTRAINT set_logs_plan_day_adhoc_check CHECK (plan_day_id IS NULL OR adhoc);

CREATE INDEX IF NOT EXISTS set_logs_plan_day_idx
  ON set_logs (plan_day_id) WHERE plan_day_id IS NOT NULL;

COMMIT;

-- 回滚（仅 staging 演练；丢失训练日归属，不丢记录）：
-- DROP INDEX IF EXISTS set_logs_plan_day_idx;
-- ALTER TABLE set_logs DROP CONSTRAINT IF EXISTS set_logs_plan_day_adhoc_check;
-- ALTER TABLE set_logs DROP COLUMN IF EXISTS plan_day_id;
