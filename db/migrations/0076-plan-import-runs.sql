-- Spec 052: counters only. Never store spreadsheet names or cell text.
BEGIN;

CREATE TABLE plan_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trainee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('file', 'paste')),
  input_chars integer NOT NULL,
  week_calls integer NOT NULL DEFAULT 0,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_import_runs_quota_idx ON plan_import_runs (coach_id, trainee_id, created_at);

COMMIT;
-- Rollback: disable DEEPSEEK_API_KEY / revert the application; retain counters.
