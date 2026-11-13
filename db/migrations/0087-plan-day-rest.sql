-- Retain prescriptions and calendar identity while a coach pauses a day.
ALTER TABLE plan_days ADD COLUMN is_rest BOOLEAN NOT NULL DEFAULT FALSE;
