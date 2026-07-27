-- Migration 0050: anonymized account deletion (spec 011 §1, 2026-07-27 revision).
--
-- DELETE /me no longer runs `DELETE FROM users`. The row survives so every
-- training record (sets, e1RM inputs, readiness, plans, chat) keeps pointing at
-- a now-nameless user id; the identifying columns are wiped in place instead.
--
-- The phone number must be RELEASED so the same person can register again with
-- it later. `users_phone_key` is a plain UNIQUE and Postgres treats NULLs as
-- distinct, so any number of anonymized rows coexist with a NULL phone — no
-- partial index needed. Dropping NOT NULL is therefore the whole mechanism; the
-- CHECK below keeps the guarantee for live accounts.

BEGIN;

SET search_path TO public;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE users
  ALTER COLUMN phone DROP NOT NULL;

-- A live account still must have a phone: only a deleted row may have none.
ALTER TABLE users
  ADD CONSTRAINT users_phone_present_unless_deleted
  CHECK (deleted_at IS NOT NULL OR phone IS NOT NULL);

COMMIT;
