-- Migration 0042: APNs device token registrations.
-- Spec: specs/019-push-pipeline/SPEC.md (card 1, section 1).

BEGIN;

CREATE TABLE device_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token          TEXT NOT NULL,
  platform       TEXT NOT NULL CHECK (platform = 'ios'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token)
);

CREATE INDEX device_tokens_user_id_idx
  ON device_tokens (user_id);

COMMIT;
