BEGIN;

SET search_path TO public;

ALTER TABLE feedback
  ADD COLUMN video_id UUID REFERENCES attachments(id) ON DELETE SET NULL;

COMMIT;
