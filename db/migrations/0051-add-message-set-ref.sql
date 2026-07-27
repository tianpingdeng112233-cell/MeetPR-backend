BEGIN;

SET search_path TO public;

ALTER TABLE messages
  ADD COLUMN set_ref JSONB NULL,
  ADD COLUMN video_id UUID NULL REFERENCES attachments(id) ON DELETE SET NULL;

ALTER TABLE messages
  ADD CONSTRAINT messages_set_ref_text_only
    CHECK (set_ref IS NULL OR kind = 'text'),
  ADD CONSTRAINT messages_video_needs_set_ref
    CHECK (video_id IS NULL OR set_ref IS NOT NULL);

CREATE INDEX messages_video_id_idx
  ON messages (video_id)
  WHERE video_id IS NOT NULL;

COMMIT;
