-- Migration 0010: plan kind (regular 4-week block vs 1-week adaptation week).
-- During an active evaluation period the publish endpoint only allows
-- kind='adaptation' plans -- the server-side hard gate (spec 005 D9).
-- Spec: specs/005-bind-eval-profile/SPEC.md
-- Source: evaluation-workflow.md v1.1 §4.2 + v0_1b_completion_wave.md §2

BEGIN;

ALTER TABLE plans
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'adaptation'));

-- Adaptation plans are always exactly 1 week (evaluation-workflow §4.2).
ALTER TABLE plans
  ADD CONSTRAINT plans_adaptation_one_week_check CHECK (kind = 'regular' OR plan_weeks = 1);

COMMIT;
