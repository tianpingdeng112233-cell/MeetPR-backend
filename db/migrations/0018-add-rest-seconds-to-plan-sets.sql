-- Migration 0018: add coach-prescribed rest seconds to plan sets.
-- NULL means unset; students keep using their automatic rest timer fallback.
-- Spec: 040 backend: per-set rest seconds on plan_sets.

BEGIN;

ALTER TABLE plan_sets
  ADD COLUMN rest_seconds INT;

COMMIT;
