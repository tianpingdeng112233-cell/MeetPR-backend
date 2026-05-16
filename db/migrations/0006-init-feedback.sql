-- Migration 0006: coach feedback and student read tracking.
-- Spec: specs/003-student-actions/SPEC.md

BEGIN;

CREATE TABLE feedback (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_date         DATE,
  plan_exercise_id UUID REFERENCES plan_exercises(id) ON DELETE SET NULL,
  text             TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 2000),
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at          TIMESTAMPTZ
);

CREATE INDEX feedback_student_posted_idx ON feedback (student_id, posted_at DESC);
CREATE INDEX feedback_student_unread_idx ON feedback (student_id, posted_at DESC) WHERE read_at IS NULL;

COMMIT;
