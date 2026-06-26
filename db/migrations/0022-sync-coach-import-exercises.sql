-- Migration 0022: sync the exercises catalog with the 3 import-coverage exercises
-- added to exercise-catalog-v2.json by spec 043's alias amendment (#188). The import
-- matcher binds 吕子豪's `离心卧推` / `弹力带窄推` / `安全杠节奏深蹲` to these ids; without
-- them in the catalog the publish FK (plan_exercises.exercise_id -> exercises.id,
-- ON DELETE RESTRICT) rejects the imported plan. Catalog follow-up to 0019; numbered
-- 0022 (next after the 0021 head). Mirrors exercise-catalog-v2.json for these ids
-- (created_at uses the column default per the 0002.1 generator convention; the JSON's
-- cosmetic createdAt is not persisted), keeping the iOS bundle and backend catalog
-- aligned on the fields the publish path and matcher rely on.
-- Idempotent: ON CONFLICT (id) upsert makes it safe to re-run.
-- Spec: specs/043-coach-plan-import/SPEC.md §动作别名表附录
-- Source: MeetPR/Modules/CoachKit/Sources/CoachKit/Resources/exercise-catalog-v2.json

BEGIN;

INSERT INTO exercises (
  id,
  name,
  name_en,
  exercise_type,
  main_lift_family,
  is_competition_lift,
  muscle_groups,
  equipment,
  movement_pattern
) VALUES
  ('00000000-0000-0000-ca70-0000000004dd'::UUID, '离心卧推', 'Eccentric Bench Press', 'main_lift_variation', 'bench', FALSE, ARRAY['chest']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
  ('00000000-0000-0000-ca70-0000000004de'::UUID, '弹力带窄推', 'Banded Close-Grip Bench Press', 'main_lift_variation', 'bench', FALSE, ARRAY['chest']::TEXT[], ARRAY['barbell', 'band']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
  ('00000000-0000-0000-ca70-0000000004df'::UUID, '安全杠节奏深蹲', 'Safety Bar Tempo Squat', 'main_lift_variation', 'squat', FALSE, ARRAY['quad']::TEXT[], ARRAY['specialty_bar']::TEXT[], ARRAY['squat']::TEXT[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  name_en = EXCLUDED.name_en,
  exercise_type = EXCLUDED.exercise_type,
  main_lift_family = EXCLUDED.main_lift_family,
  is_competition_lift = EXCLUDED.is_competition_lift,
  muscle_groups = EXCLUDED.muscle_groups,
  equipment = EXCLUDED.equipment,
  movement_pattern = EXCLUDED.movement_pattern,
  created_by_coach_id = NULL;

COMMIT;
