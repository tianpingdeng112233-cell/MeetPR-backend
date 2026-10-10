-- 邮箱注册验证码，用于先验码、后建号。
-- 纯新增表，不修改存量数据。
-- 回滚：DROP TABLE IF EXISTS email_signup_codes;
BEGIN;
SET search_path TO public;

CREATE TABLE IF NOT EXISTS email_signup_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL,
  code_hash  TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INTEGER     NOT NULL DEFAULT 0,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_signup_codes_email_idx ON email_signup_codes (email);

COMMIT;
