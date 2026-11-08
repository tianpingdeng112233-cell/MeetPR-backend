-- Additive only: absence of a row means the coach has never viewed this student.
-- Down: DROP TABLE IF EXISTS coach_student_plan_views;
BEGIN;
SET search_path TO public;

CREATE TABLE IF NOT EXISTS coach_student_plan_views (
  coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (coach_id, student_id)
);

COMMIT;
