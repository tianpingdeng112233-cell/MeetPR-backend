-- Migration 0020: relax the plan horizon from {1, 4} weeks to any 1..52 weeks.
-- Coaches importing a student's existing multi-week program (spec 043) need to
-- publish plans of arbitrary remaining length, not just the 1/4-week presets the
-- in-app authoring wizard assumes. Only the CHECK bounds widen -- the SMALLINT
-- columns already hold 1..52, existing rows are untouched, and the publish-time
-- `week_number <= plan_weeks` invariant plus the adaptation⇒1-week constraint
-- (0010) both stay intact.
-- Spec: specs/043-coach-plan-import/SPEC.md §G

BEGIN;

ALTER TABLE plans DROP CONSTRAINT plans_plan_weeks_check;
ALTER TABLE plans ADD CONSTRAINT plans_plan_weeks_check CHECK (plan_weeks BETWEEN 1 AND 52);

ALTER TABLE plan_days DROP CONSTRAINT plan_days_week_number_check;
ALTER TABLE plan_days ADD CONSTRAINT plan_days_week_number_check CHECK (week_number BETWEEN 1 AND 52);

COMMIT;
