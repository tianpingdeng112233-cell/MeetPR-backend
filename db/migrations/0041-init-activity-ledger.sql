-- Migration 0041: student activity ledger.
-- Spec: specs/018-student-activity-ledger/SPEC.md (card 1, sections 1 and 7).

BEGIN;

CREATE TABLE training_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date   DATE NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'partial')),
  started_at     TIMESTAMPTZ NOT NULL,
  last_set_at    TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ,
  plan_day_ids   UUID[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, session_date)
);

CREATE INDEX training_sessions_student_date_idx
  ON training_sessions (student_id, session_date DESC);

CREATE TABLE student_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type     TEXT NOT NULL CHECK (
    event_type IN ('session_completed', 'session_partial', 'pr_e1rm')
  ),
  session_date   DATE NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  dedup_key      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dedup_key)
);

CREATE INDEX student_events_coach_date_idx
  ON student_events (coach_id, session_date DESC);
CREATE INDEX student_events_student_occurred_idx
  ON student_events (student_id, occurred_at DESC);

CREATE TABLE student_signals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_type    TEXT NOT NULL CHECK (signal_type IN ('missed_training', 'pr_congrats')),
  severity       TEXT NOT NULL CHECK (severity IN ('red', 'yellow', 'green')),
  status         TEXT NOT NULL CHECK (status IN ('open', 'acked', 'auto_resolved', 'expired')),
  reason         TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  opened_at      TIMESTAMPTZ NOT NULL,
  acked_at       TIMESTAMPTZ,
  resolved_at    TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX student_signals_open_unique_idx
  ON student_signals (student_id, coach_id, signal_type)
  WHERE status = 'open';
CREATE INDEX student_signals_coach_status_opened_idx
  ON student_signals (coach_id, status, opened_at DESC);

-- Backfill start. Both INSERT...SELECT statements are idempotent for staging drills.
-- Completion is judged per plan exercise by comparing submitted-set counts against
-- prescribed-set counts. set_logs.set_index (0-based in the import path, mixed in
-- historical client examples) must never be equality-matched against the 1-based
-- plan_sets.set_number.
-- Session timing (started_at/last_set_at) only counts sets whose logged_at falls in
-- the gym-day window of logged_date (UTC+4h == Asia/Shanghai calendar day shifted
-- back 4h, same server-TZ=UTC assumption as the 0031 backfill); completion counts
-- every non-assumed set of the date, so late edits still complete a day (SPEC §1.1).
-- Materialized as scratch tables (dropped below): pg-mem, which runs the migration
-- tests, crashes on COUNT(DISTINCT ...) over two different left-joined tables in one
-- grouped query. Each scratch step therefore aggregates a single table at most; the
-- per-exercise done flag is computed row-wise.
CREATE TABLE backfill_session_timing (
  student_id   UUID NOT NULL,
  session_date DATE NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  last_set_at  TIMESTAMPTZ NOT NULL
);

INSERT INTO backfill_session_timing (student_id, session_date, started_at, last_set_at)
SELECT
  session_log.student_id,
  session_log.logged_date,
  MIN(session_log.logged_at),
  MAX(session_log.logged_at)
FROM set_logs session_log
WHERE NOT session_log.assumed
  AND (session_log.logged_at + INTERVAL '4 hours')::date = session_log.logged_date
GROUP BY session_log.student_id, session_log.logged_date;

CREATE TABLE backfill_touched_days (
  student_id   UUID NOT NULL,
  session_date DATE NOT NULL,
  plan_day_id  UUID NOT NULL
);

INSERT INTO backfill_touched_days (student_id, session_date, plan_day_id)
SELECT DISTINCT
  touch_log.student_id,
  touch_log.logged_date,
  touch_exercise.plan_day_id
FROM set_logs touch_log
JOIN plan_exercises touch_exercise
  ON touch_exercise.id = touch_log.plan_exercise_id
WHERE NOT touch_log.assumed;

CREATE TABLE backfill_planned_counts (
  plan_exercise_id UUID NOT NULL,
  planned_count    INT NOT NULL
);

INSERT INTO backfill_planned_counts (plan_exercise_id, planned_count)
SELECT plan_exercise_id, COUNT(*)
FROM plan_sets
GROUP BY plan_exercise_id;

-- (student, logged_date, plan_exercise_id, set_index) is unique, so a plain COUNT(*)
-- equals the number of distinct submitted sets.
CREATE TABLE backfill_submitted_counts (
  student_id       UUID NOT NULL,
  session_date     DATE NOT NULL,
  plan_exercise_id UUID NOT NULL,
  submitted_count  INT NOT NULL
);

INSERT INTO backfill_submitted_counts (student_id, session_date, plan_exercise_id, submitted_count)
SELECT student_id, logged_date, plan_exercise_id, COUNT(*)
FROM set_logs
WHERE plan_exercise_id IS NOT NULL
  AND (completed OR failed)
  AND NOT assumed
GROUP BY student_id, logged_date, plan_exercise_id;

CREATE TABLE backfill_exercise_progress (
  student_id       UUID NOT NULL,
  session_date     DATE NOT NULL,
  plan_day_id      UUID NOT NULL,
  plan_exercise_id UUID NOT NULL,
  exercise_done    INT NOT NULL
);

INSERT INTO backfill_exercise_progress (
  student_id,
  session_date,
  plan_day_id,
  plan_exercise_id,
  exercise_done
)
SELECT
  touched_day.student_id,
  touched_day.session_date,
  touched_day.plan_day_id,
  day_exercise.id AS plan_exercise_id,
  CASE
    WHEN COALESCE(submitted.submitted_count, 0) >= COALESCE(planned.planned_count, 0) THEN 1
    ELSE 0
  END AS exercise_done
FROM backfill_touched_days touched_day
JOIN plan_exercises day_exercise
  ON day_exercise.plan_day_id = touched_day.plan_day_id
LEFT JOIN backfill_planned_counts planned
  ON planned.plan_exercise_id = day_exercise.id
LEFT JOIN backfill_submitted_counts submitted
  ON submitted.student_id = touched_day.student_id
  AND submitted.session_date = touched_day.session_date
  AND submitted.plan_exercise_id = day_exercise.id;

INSERT INTO training_sessions (
  student_id,
  session_date,
  status,
  started_at,
  last_set_at,
  completed_at,
  plan_day_ids
)
SELECT
  sessions.student_id,
  sessions.session_date,
  CASE
    WHEN MIN(exercise_progress.exercise_done) = 1
    THEN 'completed'
    ELSE 'partial'
  END AS status,
  sessions.started_at,
  sessions.last_set_at,
  CASE
    WHEN MIN(exercise_progress.exercise_done) = 1
    THEN sessions.last_set_at
    ELSE NULL
  END AS completed_at,
  REPLACE(
    REPLACE(
      JSONB_AGG(DISTINCT exercise_progress.plan_day_id)::text,
      '[',
      '{'
    ),
    ']',
    '}'
  )::UUID[] AS plan_day_ids
FROM backfill_session_timing sessions
JOIN backfill_exercise_progress exercise_progress
  ON exercise_progress.student_id = sessions.student_id
  AND exercise_progress.session_date = sessions.session_date
GROUP BY
  sessions.student_id,
  sessions.session_date,
  sessions.started_at,
  sessions.last_set_at
ON CONFLICT (student_id, session_date) DO NOTHING;

INSERT INTO training_sessions (
  student_id,
  session_date,
  status,
  started_at,
  last_set_at,
  completed_at,
  plan_day_ids
)
SELECT
  adhoc_sessions.student_id,
  adhoc_sessions.session_date,
  'completed',
  adhoc_sessions.started_at,
  adhoc_sessions.last_set_at,
  adhoc_sessions.last_set_at,
  ARRAY[]::UUID[]
FROM backfill_session_timing adhoc_sessions
LEFT JOIN backfill_touched_days coached_day
  ON coached_day.student_id = adhoc_sessions.student_id
  AND coached_day.session_date = adhoc_sessions.session_date
WHERE coached_day.plan_day_id IS NULL
ON CONFLICT (student_id, session_date) DO NOTHING;
DROP TABLE backfill_exercise_progress;
DROP TABLE backfill_submitted_counts;
DROP TABLE backfill_planned_counts;
DROP TABLE backfill_touched_days;
DROP TABLE backfill_session_timing;
-- Backfill end.

COMMIT;
