-- Migration 0009: extend bind_requests with the two columns trimmed from the
-- V0.1 minimal table (0003.6): invite code linkage + skip-evaluation reason.
-- Spec: specs/005-bind-eval-profile/SPEC.md (D2)
-- Source: evaluation-workflow.md v1.1 §3.6

BEGIN;

ALTER TABLE bind_requests
  ADD COLUMN invite_code_id UUID REFERENCES invite_codes(id) ON DELETE SET NULL;

ALTER TABLE bind_requests
  ADD COLUMN skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 500);

-- One live pending request per student: backstops concurrent POST /bind-requests
-- (the in-transaction SELECT guard alone is racy — Codex review P1).
CREATE UNIQUE INDEX bind_requests_unique_pending
  ON bind_requests (student_id) WHERE status = 'pending';

COMMIT;
