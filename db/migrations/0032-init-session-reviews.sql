-- Migration 0032: session reviews (self-train Free tier wave, spec 012).
-- The walkthrough's P0-3: a student's post-session reflection vanished on
-- dismiss (session-local). One row per student per training day; rewriting
-- the same day overwrites — 日即会话, same key discipline as set_logs.
-- Spec: specs/012-review-persistence/SPEC.md (+ iOS specs/051, iOS repo)

BEGIN;

CREATE TABLE session_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_date  DATE NOT NULL,
  feeling      TEXT NOT NULL CHECK (length(trim(feeling)) > 0),
  session_rpe  NUMERIC(3,1) CHECK (session_rpe IS NULL OR (session_rpe >= 0 AND session_rpe <= 10)),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, review_date)
);

CREATE INDEX session_reviews_student_date_idx ON session_reviews (student_id, review_date DESC);

COMMIT;

-- Rollback (staging drills only):
--   BEGIN;
--   DROP INDEX session_reviews_student_date_idx;
--   DROP TABLE session_reviews;
--   COMMIT;
