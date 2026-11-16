-- 067 pre-release inventory. AUTHORING ONLY: not executed by the agent.
-- Run manually only with David's authorization. PostgreSQL, no mutations.
-- IDs only; no credentials or personal names. Effective ranges include shifted/extended training days.
-- Scope is the existing coach/student pair; plans have no binding-epoch FK.
-- Timestamp ordering matches node-postgres / JavaScript Date millisecond precision.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH published AS (
  SELECT * FROM plans WHERE status = 'published'
), batch_order AS (
  -- Mirrors plan-calendar.ts: a batch is ordered by its minimum surviving seq.
  SELECT s.batch_id, min(s.seq) AS batch_seq
  FROM plan_day_shifts s
  JOIN plan_days d ON d.id = s.plan_day_id
  JOIN published p ON p.id = d.plan_id
  GROUP BY s.batch_id
), latest_shift AS (
  SELECT DISTINCT ON (s.plan_day_id) s.plan_day_id, s.shifted_to_date
  FROM plan_day_shifts s JOIN batch_order b ON b.batch_id = s.batch_id
  ORDER BY s.plan_day_id, b.batch_seq DESC, s.seq DESC
), day_stats AS (
  SELECT d.plan_id,
    count(*) FILTER (WHERE NOT d.is_rest) AS total,
    count(*) FILTER (WHERE NOT d.is_rest AND c.id IS NOT NULL) AS completed,
    max(coalesce(s.shifted_to_date, p.start_date + (d.week_number - 1) * 7 + d.day_of_week - 1))
      FILTER (WHERE NOT d.is_rest) AS actual_end
  FROM plan_days d JOIN published p ON p.id = d.plan_id
  LEFT JOIN latest_shift s ON s.plan_day_id = d.id
  LEFT JOIN plan_day_completions c ON c.plan_day_id = d.id
  GROUP BY d.plan_id
), records AS (
  SELECT d.plan_id, l.logged_at AS at
  FROM set_logs l JOIN plan_exercises e ON e.id = l.plan_exercise_id
  JOIN plan_days d ON d.id = e.plan_day_id
  JOIN published p ON p.id = d.plan_id AND p.trainee_id = l.student_id
  UNION ALL
  SELECT d.plan_id, l.logged_at
  FROM set_logs l JOIN plan_days d ON d.id = l.plan_day_id
  JOIN published p ON p.id = d.plan_id AND p.trainee_id = l.student_id
  UNION ALL
  SELECT d.plan_id, c.completed_at
  FROM plan_day_completions c JOIN plan_days d ON d.id = c.plan_day_id
  JOIN published p ON p.id = d.plan_id
), last_record AS (
  SELECT plan_id, date_trunc('milliseconds', max(at)) AS latest_record_at FROM records GROUP BY plan_id
), facts AS (
  SELECT p.*, coalesce(d.total, 0) AS total, coalesce(d.completed, 0) AS completed,
    greatest(p.end_date, d.actual_end) AS effective_end, r.latest_record_at
  FROM published p LEFT JOIN day_stats d ON d.plan_id = p.id
  LEFT JOIN last_record r ON r.plan_id = p.id
), anchors AS (
  SELECT *, row_number() OVER (
    PARTITION BY trainee_id, coach_id ORDER BY latest_record_at DESC, date_trunc('milliseconds', created_at) DESC, id DESC
  ) AS rank
  FROM facts WHERE total > 0 AND latest_record_at IS NOT NULL
), latest AS (
  SELECT *, row_number() OVER (
    PARTITION BY trainee_id, coach_id ORDER BY date_trunc('milliseconds', published_at) DESC NULLS LAST,
      date_trunc('milliseconds', created_at) DESC, id DESC
  ) AS rank
  FROM facts
), candidates AS (
  SELECT f.*, row_number() OVER (
    PARTITION BY f.trainee_id, f.coach_id ORDER BY f.start_date, date_trunc('milliseconds', f.created_at), f.id
  ) AS rank
  FROM facts f LEFT JOIN anchors a ON a.trainee_id = f.trainee_id
    AND a.coach_id IS NOT DISTINCT FROM f.coach_id AND a.rank = 1
  WHERE f.total > f.completed AND (a.id IS NULL OR f.start_date > a.start_date)
), chosen AS (
  SELECT l.trainee_id, l.coach_id, l.id AS latest_published_id,
    CASE WHEN a.total > a.completed THEN a.id ELSE coalesce(n.id, l.id) END AS current_plan_id
  FROM latest l LEFT JOIN anchors a ON a.trainee_id = l.trainee_id
    AND a.coach_id IS NOT DISTINCT FROM l.coach_id AND a.rank = 1
  LEFT JOIN candidates n ON n.trainee_id = l.trainee_id
    AND n.coach_id IS NOT DISTINCT FROM l.coach_id AND n.rank = 1
  WHERE l.rank = 1
), report AS (
  SELECT 'published_dates_overlap' AS issue, a.trainee_id, a.coach_id,
    jsonb_build_object(
      'plan_id', a.id, 'start_date', a.start_date, 'effective_end', a.effective_end,
      'other_plan_id', b.id, 'other_start_date', b.start_date, 'other_effective_end', b.effective_end
    ) AS details
  FROM facts a JOIN facts b ON b.trainee_id = a.trainee_id
    AND b.coach_id IS NOT DISTINCT FROM a.coach_id AND a.id < b.id
  WHERE a.start_date <= b.effective_end AND b.start_date <= a.effective_end
  UNION ALL
  SELECT 'current_differs_from_latest', c.trainee_id, c.coach_id,
    jsonb_build_object('current_plan_id', c.current_plan_id, 'latest_published_id', c.latest_published_id)
  FROM chosen c WHERE c.current_plan_id <> c.latest_published_id
    AND EXISTS (SELECT 1 FROM bind_requests b WHERE b.student_id = c.trainee_id
      AND b.coach_id = c.coach_id AND b.status = 'accepted')
)
SELECT * FROM report ORDER BY issue, trainee_id, coach_id, details::text;

ROLLBACK;
