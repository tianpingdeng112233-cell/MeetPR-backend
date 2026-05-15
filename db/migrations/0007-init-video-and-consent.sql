-- Migration 0007: video attachment uploads and privacy consent audit ledger.
-- Spec: specs/004-video-upload/SPEC.md

BEGIN;

CREATE TABLE video_attachments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_exercise_id     UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
  set_index            INT NOT NULL CHECK (set_index >= 0),
  oss_key              TEXT NOT NULL UNIQUE,
  oss_upload_id        TEXT NOT NULL,
  duration_seconds     NUMERIC(5, 2) NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 121.0),
  file_size_bytes      BIGINT NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 1073741824),
  thumbnail_oss_key    TEXT NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL,
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  coach_visible_at     TIMESTAMPTZ NOT NULL,

  CONSTRAINT video_attachments_unique_set UNIQUE (student_id, plan_exercise_id, set_index)
);

CREATE INDEX video_attachments_student_recorded_idx
  ON video_attachments (student_id, recorded_at DESC);
CREATE INDEX video_attachments_plan_exercise_idx
  ON video_attachments (plan_exercise_id);

CREATE TABLE privacy_consents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_kind  TEXT NOT NULL,
  agreed_at     TIMESTAMPTZ NOT NULL,
  user_agent    TEXT,
  ip_address    INET,

  UNIQUE (user_id, consent_kind)
);

CREATE INDEX privacy_consents_user_idx ON privacy_consents (user_id, agreed_at DESC);

COMMIT;
