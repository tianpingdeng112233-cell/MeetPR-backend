BEGIN;
SET search_path TO public;
ALTER TABLE video_markers
  ADD COLUMN IF NOT EXISTS attachment_id UUID NULL REFERENCES attachments(id) ON DELETE SET NULL;
COMMIT;
