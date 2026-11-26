-- Null retains the submitted-at attribution used by existing clients and historical rows.
ALTER TABLE public.plan_day_completions ADD COLUMN IF NOT EXISTS actual_completion_date DATE;
