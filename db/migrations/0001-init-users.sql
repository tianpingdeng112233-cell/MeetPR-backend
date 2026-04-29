-- Migration 0001: initialize users table.
-- Spec: specs/001-auth/SPEC.md
-- ADR: 003 v4 (single role per user, V1) · 004 (no ORM, hand-managed SQL).

BEGIN;

CREATE TABLE users (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  phone               TEXT         NOT NULL,
  apple_user_id       TEXT,
  password_hash       TEXT         NOT NULL,
  role                TEXT         NOT NULL,
  refresh_token_jti   UUID,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT users_phone_key  UNIQUE (phone),
  CONSTRAINT users_role_check CHECK (role IN ('coach', 'coached_student', 'self_train_student'))
);

-- Apple Sign-In (deferred): nullable column with partial unique index -- only enforces
-- uniqueness for rows that actually have an apple_user_id, so V1 password-only users
-- don't conflict on NULL.
CREATE UNIQUE INDEX users_apple_user_id_key
  ON users (apple_user_id)
  WHERE apple_user_id IS NOT NULL;

COMMIT;
