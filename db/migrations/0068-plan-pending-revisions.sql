-- Migration 0068: server-side pending revisions for training plans.
-- Spec: specs/044-plan-pending-revision/SPEC.md

BEGIN;

CREATE TABLE plan_pending_revisions (
  plan_id      UUID        PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
  coach_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      INTEGER     NOT NULL,
  content_hash TEXT        NOT NULL,
  content      JSONB       NOT NULL,
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plan_pending_revisions_coach_id_idx
  ON plan_pending_revisions (coach_id);

COMMIT;
