-- Spec 069: standalone chat videos. No row edits or backfill.
BEGIN;
SET search_path TO public;
ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check
  CHECK (kind IN ('set_video', 'onboarding_video', 'onboarding_doc', 'chat_image', 'chat_video'));
ALTER TABLE messages DROP CONSTRAINT messages_video_needs_set_ref;
ALTER TABLE messages ADD CONSTRAINT messages_video_text_only
  CHECK (video_id IS NULL OR kind = 'text');
-- 0086 retains the exercise_ref/video_id mutual exclusion.
COMMIT;
