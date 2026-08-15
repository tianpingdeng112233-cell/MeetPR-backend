BEGIN;
SET search_path TO public;

CREATE TABLE IF NOT EXISTS password_reset_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,             -- sha256;明文只进邮件
  expires_at TIMESTAMPTZ NOT NULL,             -- 签发 +10min
  attempts   INTEGER     NOT NULL DEFAULT 0,   -- 达 5 即作废
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_codes_user_id_idx
  ON password_reset_codes (user_id);

-- Apple 授权码换来的 refresh token,唯一用途是注销时吊销。
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS apple_refresh_token TEXT;

COMMIT;
