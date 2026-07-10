-- Migration 0035: immutable set-video provenance and OSS-verified lifecycle.
--
-- Retains the plan/coach that made a linked video visible even if a legacy
-- data repair later detaches set_log_id, and repairs the status CHECK so the
-- upload state machine can express the failed/deleting lifecycle transitions.
-- Existing linked videos are backfilled before future writes rely on the
-- immutable provenance fields.
--
-- (The set_logs FK RESTRICT hardening and the `assumed` column shipped earlier
-- in migration 0034; only the attachment-side changes remain here.)

BEGIN;

-- Linked videos retain the plan/coach that made them visible even if a legacy
-- data repair later detaches set_log_id. New explicitly-unlinked uploads are
-- marked separately; pre-migration null links stay unproven and are never
-- exposed to a coach.
ALTER TABLE attachments
  ADD COLUMN source_plan_id UUID REFERENCES plans(id) ON DELETE RESTRICT,
  ADD COLUMN source_coach_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN is_unlinked_explicit BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN part_count SMALLINT NOT NULL DEFAULT 1 CHECK (part_count >= 1 AND part_count <= 200),
  ADD COLUMN actual_size_bytes BIGINT CHECK (actual_size_bytes IS NULL OR actual_size_bytes >= 0);

UPDATE attachments AS a
SET
  source_plan_id = p.id,
  source_coach_id = p.coach_id,
  is_unlinked_explicit = FALSE
FROM set_logs AS sl
JOIN plan_exercises AS pe ON pe.id = sl.plan_exercise_id
JOIN plan_days AS pd ON pd.id = pe.plan_day_id
JOIN plans AS p ON p.id = pd.plan_id
WHERE a.set_log_id = sl.id;

ALTER TABLE attachments
  DROP CONSTRAINT attachments_status_check;

ALTER TABLE attachments
  ADD CONSTRAINT attachments_status_check
  CHECK (status IN ('uploading', 'completing', 'aborting', 'ready', 'aborted', 'failed', 'deleting'));

CREATE INDEX attachments_source_coach_wall_idx
  ON attachments (owner_id, source_coach_id, created_at DESC)
  WHERE kind = 'set_video' AND status = 'ready';

COMMIT;
