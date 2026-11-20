-- Existing training days keep their current execution and history semantics.
ALTER TABLE public.plan_days ADD COLUMN is_placeholder BOOLEAN NOT NULL DEFAULT FALSE;
