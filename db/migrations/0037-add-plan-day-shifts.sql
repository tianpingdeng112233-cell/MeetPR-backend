-- Migration 0037: add an additive calendar-date override for a coached
-- student's plan day without mutating the immutable published plan tree.

BEGIN;

CREATE TABLE plan_day_shifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_day_id     UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES users(id),
  shifted_to_date DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_day_id)
);

COMMIT;
