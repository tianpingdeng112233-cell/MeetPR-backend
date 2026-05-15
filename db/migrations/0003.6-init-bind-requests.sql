-- Migration 0003.6: student/coach bind requests.
-- Spec: specs/003-student-actions/SPEC.md
-- Source: data-model.md v1.1 §1.5

BEGIN;

CREATE TYPE bind_request_status AS ENUM (
  'pending',
  'accepted',
  'rejected',
  'expired',
  'cancelled'
);

CREATE TABLE bind_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            bind_request_status NOT NULL DEFAULT 'pending',
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at      TIMESTAMPTZ,
  expired_at        TIMESTAMPTZ NOT NULL,
  skip_evaluation   BOOLEAN NOT NULL DEFAULT FALSE,
  rejection_silent  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX bind_requests_unique_accepted
  ON bind_requests (student_id, coach_id) WHERE status = 'accepted';

CREATE INDEX bind_requests_coach_status_idx ON bind_requests (coach_id, status);
CREATE INDEX bind_requests_student_status_idx ON bind_requests (student_id, status);

COMMIT;
