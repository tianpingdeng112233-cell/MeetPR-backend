-- Migration 0021: add a student-visible coach note to each plan set.
-- Imported plans (spec 043) carry intensity shorthand the parser cannot
-- structure (e.g. `70%top`, `节奏3-1-0`, `力竭`). The coach fills a real
-- weight/RPE target and the original cue rides along as `coach_note`, shown
-- next to the set for the student. NULL means no note; existing rows stay NULL.
-- Spec: specs/043-coach-plan-import/SPEC.md §G

BEGIN;

ALTER TABLE plan_sets
  ADD COLUMN coach_note TEXT;

COMMIT;
