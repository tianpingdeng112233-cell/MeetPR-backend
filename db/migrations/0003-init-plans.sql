-- Migration 0003: training plan tree (plans → plan_days → plan_exercises → plan_sets).
-- Spec: specs/002-coach-planning-crud/SPEC.md
-- Source: data-model.md v1.1 §1.8
-- ADR: 004 (no ORM, hand-managed SQL). All cascades hand-modeled -- no triggers.

BEGIN;

CREATE TABLE plans (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id            UUID         REFERENCES users(id) ON DELETE RESTRICT,
  trainee_id          UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name                TEXT         NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  start_date          DATE         NOT NULL,
  end_date            DATE         NOT NULL,
  plan_weeks          SMALLINT     NOT NULL,
  source              TEXT         NOT NULL,
  source_template_id  UUID,
  status              TEXT         NOT NULL DEFAULT 'draft',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT plans_plan_weeks_check  CHECK (plan_weeks IN (1, 4)),
  CONSTRAINT plans_source_check      CHECK (source IN ('coach', 'template', 'algorithm')),
  CONSTRAINT plans_status_check      CHECK (status IN ('draft', 'published', 'completed', 'paused')),
  CONSTRAINT plans_dates_order_check CHECK (end_date >= start_date),
  CONSTRAINT plans_template_consistency CHECK (
    (source = 'template' AND source_template_id IS NOT NULL) OR
    (source <> 'template' AND source_template_id IS NULL)
  )
);

CREATE INDEX plans_coach_id_idx        ON plans (coach_id) WHERE coach_id IS NOT NULL;
CREATE INDEX plans_trainee_id_idx      ON plans (trainee_id);
CREATE INDEX plans_coach_trainee_idx   ON plans (coach_id, trainee_id);

CREATE TABLE plan_days (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID         NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day_of_week   SMALLINT     NOT NULL,
  week_number   SMALLINT     NOT NULL,
  sort_order    INT          NOT NULL DEFAULT 0,

  CONSTRAINT plan_days_day_of_week_check CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT plan_days_week_number_check CHECK (week_number BETWEEN 1 AND 4),
  CONSTRAINT plan_days_sort_order_check  CHECK (sort_order >= 0)
);

CREATE INDEX plan_days_plan_id_idx ON plan_days (plan_id, week_number, day_of_week, sort_order);

CREATE TABLE plan_exercises (
  id           UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_day_id  UUID     NOT NULL REFERENCES plan_days(id)  ON DELETE CASCADE,
  exercise_id  UUID     NOT NULL REFERENCES exercises(id)  ON DELETE RESTRICT,
  is_main_lift BOOLEAN  NOT NULL DEFAULT FALSE,
  sort_order   INT      NOT NULL DEFAULT 0,
  notes        TEXT,

  CONSTRAINT plan_exercises_sort_order_check CHECK (sort_order >= 0)
);

CREATE INDEX plan_exercises_plan_day_id_idx ON plan_exercises (plan_day_id, sort_order);
CREATE INDEX plan_exercises_exercise_id_idx ON plan_exercises (exercise_id);

CREATE TABLE plan_sets (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_exercise_id    UUID          NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
  set_number          SMALLINT      NOT NULL,
  target_reps         SMALLINT      NOT NULL,
  target_reps_max     SMALLINT,
  intensity_mode      TEXT          NOT NULL,
  target_value        NUMERIC(6, 2) NOT NULL,
  set_type            TEXT          NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT plan_sets_set_number_check      CHECK (set_number >= 1),
  CONSTRAINT plan_sets_target_reps_check     CHECK (target_reps BETWEEN 1 AND 50),
  CONSTRAINT plan_sets_target_reps_max_check CHECK (
    target_reps_max IS NULL OR (target_reps_max BETWEEN target_reps AND 50)
  ),
  CONSTRAINT plan_sets_intensity_mode_check CHECK (intensity_mode IN ('weight', 'rpe')),
  CONSTRAINT plan_sets_set_type_check       CHECK (set_type IN ('warmup', 'working', 'failed', 'amrap', 'backoff')),
  CONSTRAINT plan_sets_target_value_check   CHECK (
    (intensity_mode = 'rpe'    AND target_value BETWEEN 1.0 AND 10.0) OR
    (intensity_mode = 'weight' AND target_value > 0 AND target_value < 1000)
  )
);

CREATE INDEX plan_sets_plan_exercise_id_idx ON plan_sets (plan_exercise_id, set_number);

COMMIT;
