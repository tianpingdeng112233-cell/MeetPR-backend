-- Migration 0082: coach unbind and student aliases.
-- Spec: specs/057-coach-unbind-alias/SPEC.md
-- Safe to submit as one DMS SQLConsole script: the new enum value is not
-- used by any statement in this script, including constraints and defaults.

ALTER TYPE bind_request_status ADD VALUE IF NOT EXISTS 'ended';

ALTER TABLE bind_requests ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS coach_student_aliases (
  coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (coach_id, student_id)
);

-- Down (destructive; back up aliases and ended_at and obtain approval first):
-- DROP TABLE IF EXISTS coach_student_aliases;
-- ALTER TABLE bind_requests DROP COLUMN IF EXISTS ended_at;
-- PostgreSQL cannot remove a single enum value. Keep 'ended' in the enum;
-- do not rewrite or delete historical bind_requests rows on rollback.
