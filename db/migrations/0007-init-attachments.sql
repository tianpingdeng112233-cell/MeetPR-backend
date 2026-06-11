-- Migration 0007: generic attachments (presigned multipart upload pipeline).
-- Spec: specs/004-attachment-upload/SPEC.md

BEGIN;

CREATE TABLE attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('set_video', 'onboarding_video', 'onboarding_doc')),
  oss_key       TEXT NOT NULL UNIQUE,
  -- OSS multipart upload ID; kept after complete/abort for audit.
  oss_upload_id TEXT,
  content_type  TEXT NOT NULL,
  -- Client-declared size, gated per kind at initiate (200 MB video / 20 MB doc).
  size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0),
  -- Original client filename, display-only (never used in oss_key).
  filename      TEXT CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 255),
  status        TEXT NOT NULL DEFAULT 'uploading'
                CHECK (status IN ('uploading', 'ready', 'aborted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attachments_owner_created_idx ON attachments (owner_id, created_at DESC);

COMMIT;
