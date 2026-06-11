-- Migration 0015: server-side set_log <-> attachment association (spec 007).
-- iOS spec 027 shipped the student upload with a local-only JSON link, which
-- the coach's device can never see; the cross-device video wall (iOS spec
-- 029 second pass) needs the association to live here.
-- Spec: specs/007-video-setlog-link/SPEC.md

BEGIN;

ALTER TABLE attachments
  ADD COLUMN set_log_id UUID REFERENCES set_logs(id) ON DELETE SET NULL;

-- The video-wall query path: a student's ready set videos, newest first.
CREATE INDEX attachments_set_video_wall_idx
  ON attachments (owner_id, created_at DESC)
  WHERE kind = 'set_video' AND status = 'ready';

COMMIT;
