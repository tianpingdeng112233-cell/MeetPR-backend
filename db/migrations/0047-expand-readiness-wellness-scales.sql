-- Migration 0047: wire the five-point readiness wellness scale and expand
-- muscle-fatigue severity from 1-3 to 1-5.
-- Spec: specs/006-readiness/SPEC.md (authority: iOS spec 030 §C7).

BEGIN;

-- A persisted scale version makes the historical UPDATE genuinely idempotent.
-- Existing rows receive version 3, are mapped once, and are marked version 5;
-- on a staging re-run the column already defaults to 5 and the WHERE clause
-- matches no previously migrated row. A marker is necessary because the new
-- severity 3 (mapped from old 2) is indistinguishable from an old severity 3.
ALTER TABLE readiness_checkins
  ADD COLUMN IF NOT EXISTS muscle_fatigue_scale_version SMALLINT NOT NULL DEFAULT 3
    CHECK (muscle_fatigue_scale_version IN (3, 5));

-- muscle_fatigue is an array of objects, so replace every severity key in its
-- JSONB representation: old 1 stays 1, old 2 becomes 3, and old 3 becomes 5.
-- Both PostgreSQL's spaced JSONB text and pg-mem's compact form are handled.
UPDATE readiness_checkins
SET
  muscle_fatigue = REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(muscle_fatigue::TEXT, '"severity": 3', '"severity": 5'),
        '"severity":3',
        '"severity":5'
      ),
      '"severity": 2',
      '"severity": 3'
    ),
    '"severity":2',
    '"severity":3'
  )::JSONB,
  muscle_fatigue_scale_version = 5
WHERE muscle_fatigue_scale_version = 3;

ALTER TABLE readiness_checkins
  ALTER COLUMN muscle_fatigue_scale_version SET DEFAULT 5;

COMMIT;

-- Rollback (staging drills only):
--   BEGIN;
--   UPDATE readiness_checkins
--   SET muscle_fatigue = REPLACE(
--     REPLACE(
--       REPLACE(
--         REPLACE(muscle_fatigue::TEXT, '"severity": 3', '"severity": 2'),
--         '"severity":3',
--         '"severity":2'
--       ),
--       '"severity": 5',
--       '"severity": 3'
--     ),
--     '"severity":5',
--     '"severity":3'
--   )::JSONB
--   WHERE muscle_fatigue_scale_version = 5;
--   ALTER TABLE readiness_checkins DROP COLUMN muscle_fatigue_scale_version;
--   COMMIT;
