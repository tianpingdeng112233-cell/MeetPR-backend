-- Migration 0038: replace the users refresh-token slot with independently
-- revocable sessions while preserving every currently issued refresh token.

BEGIN;
SET search_path TO public;

CREATE TABLE sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_jti     UUID NOT NULL,
  prev_jti              UUID,
  prev_jti_valid_until  TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX sessions_refresh_token_jti_key
  ON sessions (refresh_token_jti);

CREATE INDEX sessions_prev_jti_idx
  ON sessions (prev_jti)
  WHERE prev_jti IS NOT NULL;

CREATE INDEX sessions_user_active_last_used_idx
  ON sessions (user_id, last_used_at)
  WHERE revoked_at IS NULL;

-- Zero-logout backfill: the legacy users column remains in place for rollback
-- safety, but application code no longer uses it as mutable session state.
INSERT INTO sessions (user_id, refresh_token_jti, created_at, last_used_at)
SELECT id, refresh_token_jti, created_at, updated_at
FROM users
WHERE refresh_token_jti IS NOT NULL;

COMMIT;
