-- Migration 0044: add the single platform administrator role.
-- V1 admin access is read-only; account creation remains operator-only.

BEGIN;

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('coach', 'coached_student', 'self_train_student', 'admin'));

CREATE UNIQUE INDEX users_single_admin_idx
  ON users ((true))
  WHERE role = 'admin';

COMMIT;
