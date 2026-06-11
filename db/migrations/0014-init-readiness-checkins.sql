-- Migration 0014: daily readiness check-ins (sleep / mood / stress + muscle fatigue).
-- muscle_fatigue is a JSONB array of { muscle_group, severity } objects (spec-locked:
-- no join table). Vocabulary + severity bounds are enforced in zod (the real gate);
-- scale bounds are double-enforced via CHECK.
-- Spec: specs/006-readiness/SPEC.md (authority: iOS spec 030 §C7)

BEGIN;

CREATE TABLE readiness_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,
  sleep_quality SMALLINT NOT NULL CHECK (sleep_quality BETWEEN 1 AND 5),
  mood SMALLINT NOT NULL CHECK (mood BETWEEN 1 AND 5),
  stress SMALLINT NOT NULL CHECK (stress BETWEEN 1 AND 5),
  muscle_fatigue JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, checkin_date)
);

COMMIT;
