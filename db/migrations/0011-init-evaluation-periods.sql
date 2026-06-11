-- Migration 0011: 7-day evaluation periods.
-- Lazy expiry model: overdue is computed at read time from expected_end_at;
-- nothing auto-completes (spec 005 D7). The overdue push columns from the wiki
-- draft are dropped -- V0.1b has no APNs (wave decision).
-- Spec: specs/005-bind-eval-profile/SPEC.md
-- Source: evaluation-workflow.md v1.1 §4.5

BEGIN;

CREATE TABLE evaluation_periods (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bind_request_id  UUID NOT NULL REFERENCES bind_requests(id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_end_at  TIMESTAMPTZ NOT NULL,
  completed_at     TIMESTAMPTZ,
  completion_type  TEXT CHECK (completion_type IS NULL OR completion_type IN ('coach_completed', 'auto_completed', 'overdue', 'cancelled')),
  -- completed_at and completion_type are set together or not at all.
  CONSTRAINT evaluation_periods_completion_consistency
    CHECK ((completed_at IS NULL) = (completion_type IS NULL))
);

-- One active evaluation period per (student, coach) pair (spec 005 D8).
CREATE UNIQUE INDEX evaluation_periods_one_active
  ON evaluation_periods (student_id, coach_id) WHERE completed_at IS NULL;

CREATE INDEX evaluation_periods_coach_idx   ON evaluation_periods (coach_id, started_at DESC);
CREATE INDEX evaluation_periods_student_idx ON evaluation_periods (student_id, started_at DESC);

COMMIT;
