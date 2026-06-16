-- Migration 0017: add failed flag to student set logs.
-- A completed set log means the set was logged; failed marks completed
-- attempts that fell short while preserving actual weight and reps achieved.
-- Spec: MeetPR/specs/039-set-failed-outcome/SPEC.md (iOS repo)

BEGIN;

ALTER TABLE set_logs
  ADD COLUMN failed BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
