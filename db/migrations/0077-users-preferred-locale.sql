BEGIN;
SET search_path TO public;

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_locale TEXT NULL
  CHECK (preferred_locale IN ('zh-Hans', 'zh-Hant', 'en'));

COMMIT;

-- Rollback: deploy the previous application and retain this nullable column.
-- No backfill: existing users retain NULL and deployment-specific defaults.
