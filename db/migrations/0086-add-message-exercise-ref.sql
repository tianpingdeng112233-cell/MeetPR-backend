-- SPEC 065: additive frozen exercise-note reference; no existing messages change.
BEGIN;
ALTER TABLE messages ADD COLUMN exercise_ref JSONB NULL;
ALTER TABLE messages
  ADD CONSTRAINT messages_exercise_ref_text_only CHECK (exercise_ref IS NULL OR kind = 'text'),
  ADD CONSTRAINT messages_exercise_ref_excludes_set_ref CHECK (exercise_ref IS NULL OR set_ref IS NULL),
  ADD CONSTRAINT messages_exercise_ref_excludes_video CHECK (exercise_ref IS NULL OR video_id IS NULL);
COMMIT;
