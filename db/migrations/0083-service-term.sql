-- Service terms belong to a single binding; existing bonds remain unset.
-- Down (manual, discards service terms): ALTER TABLE bind_requests DROP COLUMN IF EXISTS service_until;
ALTER TABLE bind_requests ADD COLUMN IF NOT EXISTS service_until DATE;
