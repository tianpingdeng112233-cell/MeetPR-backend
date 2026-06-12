-- Migration 0016: add the missing 相扑硬拉 (Competition Sumo Deadlift) main lift.
-- The catalog carried 16 sumo VARIATIONS but no base sumo pull, and the three
-- synthetic main lifts (0002) only covered squat / bench / conventional
-- deadlift — a sumo puller could not pick their actual competition stance as
-- the day's main lift (David 2026-06-12, found dogfooding Step 3 search).
-- The iOS demo seed (InMemoryPlanRepository.competitionLiftSeeds) has carried
-- the sumo main all along; this aligns staging with it. Fields mirror that
-- seed; naming pairs with the existing '传统硬拉' sibling.

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
) VALUES (
  'faa76bdb-844a-42a2-8298-ed073e9915c1'::UUID,
  '相扑硬拉',
  'Competition Sumo Deadlift',
  'main_lift',
  'deadlift',
  TRUE,
  ARRAY['back', 'hamstring', 'glute']::TEXT[],
  ARRAY['barbell']::TEXT[],
  ARRAY['hip_hinge']::TEXT[]
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
