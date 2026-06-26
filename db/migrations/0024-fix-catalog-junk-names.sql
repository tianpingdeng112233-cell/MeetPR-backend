-- Migration 0024: clean junk exercises surfaced in the plan-web exercise search.
-- Mirrors iOS exercise-catalog-v2.json cleanup (meetpr#192). Idempotent.

BEGIN;

-- Self-contradictory entry (biceps-curl name + leg muscles + squat pattern).
UPDATE exercises
SET name = '哑铃二头弯举',
    name_en = 'DB Biceps Curl',
    muscle_groups = ARRAY['biceps']::TEXT[],
    movement_pattern = ARRAY['other']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-0000000002a3';

-- Authoring notes leaked into the name field.
UPDATE exercises SET name = '杠铃反向弓步蹲'
WHERE id = '00000000-0000-0000-ca70-0000000000eb';

UPDATE exercises SET name = '胫骨前肌抬举'
WHERE id = '00000000-0000-0000-ca70-00000000010f';

COMMIT;
