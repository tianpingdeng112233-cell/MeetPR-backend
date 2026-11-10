-- SPEC 065: preserve existing rows and values; allow unfilled actual weights.
BEGIN;
ALTER TABLE set_logs ALTER COLUMN weight_kg DROP NOT NULL;
COMMIT;
