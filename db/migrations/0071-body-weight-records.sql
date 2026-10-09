-- Spec 046: one body weight record per user and calendar date.
BEGIN;

CREATE TABLE IF NOT EXISTS body_weight_records (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_on DATE NOT NULL,
  weight_kg NUMERIC(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, recorded_on)
);

-- Backfill only the new table; preserve every existing profile column.
INSERT INTO body_weight_records (user_id, recorded_on, weight_kg, created_at, updated_at)
SELECT p.user_id,
       (p.updated_at AT TIME ZONE COALESCE(tz.name, 'UTC'))::date,
       p.weight_kg,
       p.updated_at,
       p.updated_at
FROM student_onboarding_profiles AS p
JOIN users AS u ON u.id = p.user_id
LEFT JOIN pg_timezone_names AS tz ON tz.name = u.timezone
WHERE p.weight_kg IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM body_weight_records AS r WHERE r.user_id = p.user_id
  )
ON CONFLICT (user_id, recorded_on) DO NOTHING;

COMMIT;
