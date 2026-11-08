-- Read-only verification after the separately approved 0075 migration.
SELECT current_database(), version();
SELECT to_regclass('public.coach_applications') AS applications_table;
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name = 'coach_applications'
       OR (table_name = 'password_reset_codes' AND column_name = 'purpose'))
ORDER BY table_name, ordinal_position;
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'coach_applications';
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.coach_applications'::regclass
   OR (conrelid = 'public.password_reset_codes'::regclass
       AND pg_get_constraintdef(oid) LIKE '%purpose%')
ORDER BY conname;
-- Rollback policy: disable COACH_ONBOARDING_ENABLED and/or restore the previous
-- binary. Keep applications, identities, invite codes and purpose column/data.
-- No DROP/DELETE/user-remapping is part of this card's rollback.
