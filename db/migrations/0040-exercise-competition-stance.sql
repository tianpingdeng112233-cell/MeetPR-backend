-- Migration 0040: classify stance-specific competition lifts from catalog data.
-- IDs below are cross-check notes only; names are the migration key so this does
-- not introduce another application-maintained exercise-ID mirror.

BEGIN;

SET search_path TO public;

ALTER TABLE exercises
  ADD COLUMN competition_stance TEXT,
  ADD CONSTRAINT exercises_competition_stance_check
    CHECK (
      competition_stance IS NULL OR
      competition_stance IN ('low_bar', 'high_bar', 'conventional', 'sumo')
    );

UPDATE exercises SET competition_stance = 'low_bar'
WHERE name = '低杠位深蹲'; -- 00000000-0000-0000-ca71-000000000001

UPDATE exercises SET competition_stance = 'high_bar'
WHERE name = '高杠位深蹲'; -- 00000000-0000-0000-ca70-000000000016

UPDATE exercises SET competition_stance = 'conventional'
WHERE name = '传统硬拉'; -- 4a912d5c-2248-4f3d-80ec-384f8360c315

UPDATE exercises SET competition_stance = 'sumo'
WHERE name = '相扑硬拉'; -- faa76bdb-844a-42a2-8298-ed073e9915c1

COMMIT;

-- Rollback (staging drills only):
--   ALTER TABLE exercises DROP COLUMN competition_stance;
