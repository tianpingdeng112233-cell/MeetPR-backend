-- Migration 0064: add global identity providers without backfilling CN users.

BEGIN;
SET search_path TO public;

-- OAuth-only accounts do not have a phone. Existing phone rows and the
-- users_phone_key unique constraint are deliberately untouched.
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- An expression index avoids a database extension and preserves the submitted
-- spelling while enforcing the email credential's case-insensitive identity.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON users (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_identities (
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  provider_uid      TEXT        NOT NULL,
  email_at_provider TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_identities_provider_check
    CHECK (provider IN ('apple', 'google', 'email')),
  CONSTRAINT user_identities_provider_uid_key
    UNIQUE (provider, provider_uid)
);

CREATE INDEX IF NOT EXISTS user_identities_user_id_idx
  ON user_identities (user_id);

-- OIDC nonces are issued by this service and consumed exactly once. Only the
-- digest is persisted so a database read cannot recover a usable challenge.
CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce_hash TEXT        PRIMARY KEY,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_challenges_issued_at_idx
  ON auth_challenges (issued_at);

COMMIT;

-- Rollback (staging drills only):
--   BEGIN;
--   DROP TABLE auth_challenges;
--   DROP TABLE user_identities;
--   DROP INDEX users_email_lower_key;
--   ALTER TABLE users DROP COLUMN email_verified_at;
--   ALTER TABLE users DROP COLUMN email;
--   -- Restore NOT NULL only after proving no global-only accounts exist.
--   ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
--   COMMIT;
