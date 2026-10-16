-- Spec 093: CN-only, opt-in coach onboarding. Existing auth remains unchanged.
BEGIN;
SET search_path TO public;
CREATE TABLE IF NOT EXISTS coach_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email TEXT NOT NULL CHECK (email = lower(trim(email))),
  contact TEXT CHECK (contact IS NULL OR length(contact) <= 200),
  student_count INTEGER NOT NULL CHECK (student_count BETWEEN 0 AND 100000),
  device TEXT NOT NULL CHECK (device IN ('iphone', 'android', 'both')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  user_id UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coach_applications_email_key
  ON coach_applications (email);
CREATE INDEX IF NOT EXISTS coach_applications_created_idx ON coach_applications (created_at DESC);
-- Purpose separates high-entropy setup links from legacy six-digit recovery codes.
ALTER TABLE password_reset_codes ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'password_reset'
  CHECK (purpose IN ('password_reset', 'coach_setup'));
COMMIT;
-- Roll back the binary/config gate first; retain additive tables and data.
