-- Migration 0023: retain training history, make set-video provenance immutable,
-- and persist upload/outbox recovery state.
--
-- This migration intentionally repairs earlier ON DELETE CASCADE / SET NULL
-- choices. Existing linked videos are backfilled before future writes rely on
-- the immutable provenance fields.

BEGIN;

-- Historical performance must never disappear merely because a coach edits a
-- plan tree. Published trees are immutable in the API; this FK is the DB
-- backstop for every other writer as well.
ALTER TABLE set_logs
  DROP CONSTRAINT set_logs_plan_exercise_id_fkey;

ALTER TABLE set_logs
  ADD CONSTRAINT set_logs_plan_exercise_id_fkey
  FOREIGN KEY (plan_exercise_id) REFERENCES plan_exercises(id) ON DELETE RESTRICT;

ALTER TABLE set_logs
  ADD COLUMN assumed BOOLEAN NOT NULL DEFAULT FALSE;

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

-- A durable record is created in the same transaction as publication. A later
-- worker/provider integration can retry pending records without asking the
-- coach to re-publish an already published plan.
CREATE TABLE notification_outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     TEXT NOT NULL,
  aggregate_id   UUID NOT NULL,
  recipient_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempt_count  INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ,
  UNIQUE (event_type, aggregate_id, recipient_id)
);

CREATE INDEX notification_outbox_pending_idx
  ON notification_outbox (created_at ASC)
  WHERE status = 'pending';

COMMIT;
