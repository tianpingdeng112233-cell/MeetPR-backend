-- Migration 0008: coach invite codes (3 types: personal_permanent / single_use / time_limited).
-- Spec: specs/005-bind-eval-profile/SPEC.md
-- Source: evaluation-workflow.md v1.1 §2.3

BEGIN;

CREATE TABLE invite_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) = 10),
  type        TEXT NOT NULL CHECK (type IN ('personal_permanent', 'single_use', 'time_limited')),
  max_uses    INT CHECK (max_uses IS NULL OR max_uses >= 1),
  used_count  INT NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  label       TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active personal permanent code per coach; regeneration revokes
-- the previous one inside the same transaction (spec 005 D6).
CREATE UNIQUE INDEX invite_codes_one_active_personal
  ON invite_codes (coach_id) WHERE type = 'personal_permanent' AND revoked_at IS NULL;

CREATE INDEX invite_codes_coach_created_idx ON invite_codes (coach_id, created_at DESC);

COMMIT;
