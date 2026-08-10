-- Migration 0059: backfill plan_day_completions for days already in the past
-- under the pre-sequence-progression (calendar-anchored) regime.
--
-- Why: 0057 created plan_day_completions empty, so every student upgrading to
-- iOS 1.0(18) saw the cursor (first day with no completion, spec 035 §术语与
-- 排序正典) rewind to W1 of their plan — a P0 regression observed 2026-08-10.
--
-- Cutoff semantics (David 2026-08-10, option B): a day counts as "already
-- past" iff its OLD-REGIME effective date — the latest plan_day_shifts row
-- (created_at desc, id tiebreak; see src/domain/plan-calendar.ts
-- latestShiftByDay) falling back to the positional planned date — is before
-- 2026-08-09, the day 1.0(18) reached external testers. Days shifted to
-- 2026-08-09 or later stay incomplete so the cursor lands where the old
-- calendar left the student.
--
-- ON CONFLICT keeps every real manual/auto completion untouched.

BEGIN;

SET search_path TO public;

-- Pin the date -> timestamptz casts below to UTC midnight regardless of the
-- session TimeZone the migration runs under (imported-history precedent).
SET LOCAL timezone = 'UTC';

INSERT INTO plan_day_completions (plan_day_id, student_id, source, completed_at)
SELECT
  pd.id,
  p.trainee_id,
  'backfill',
  -- UTC midnight via the SET LOCAL TIME ZONE above.
  COALESCE(
    ls.shifted_to_date,
    p.start_date + ((pd.week_number - 1) * 7 + (pd.day_of_week - 1))
  )::timestamptz
FROM plan_days pd
JOIN plans p ON p.id = pd.plan_id
LEFT JOIN (
  -- Greatest-per-day shift row: same winner as latestShiftByDay().
  SELECT s1.plan_day_id, s1.shifted_to_date
  FROM plan_day_shifts s1
  LEFT JOIN plan_day_shifts s2
    ON s2.plan_day_id = s1.plan_day_id
   AND (
     s2.created_at > s1.created_at
     OR (s2.created_at = s1.created_at AND s2.id > s1.id)
   )
  WHERE s2.id IS NULL
) ls ON ls.plan_day_id = pd.id
WHERE p.status IN ('published', 'completed')
  AND COALESCE(
    ls.shifted_to_date,
    p.start_date + ((pd.week_number - 1) * 7 + (pd.day_of_week - 1))
  ) < DATE '2026-08-09'
ON CONFLICT (plan_day_id) DO NOTHING;

COMMIT;
