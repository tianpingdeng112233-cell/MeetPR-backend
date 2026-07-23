-- Migration 0049: mark disposable test accounts so production data cleanup is guarded.

BEGIN;

SET search_path TO public;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

UPDATE users
SET is_test = true
WHERE (id::text, phone) IN (
  ('00000000-0000-0000-0000-000000000001', '+8613800000001'),
  ('00000000-0000-0000-0000-000000000002', '+8613800000002')
);

COMMIT;
