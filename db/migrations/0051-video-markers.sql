BEGIN;

SET search_path TO public;

CREATE TABLE video_markers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  coach_id   UUID NOT NULL REFERENCES users(id),
  time_ms    INT NOT NULL CHECK (time_ms >= 0),
  level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'bad')),
  note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX video_markers_video_time_idx
  ON video_markers (video_id, time_ms);

COMMIT;
