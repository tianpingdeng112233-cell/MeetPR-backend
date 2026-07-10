-- Migration 0036: durable notification outbox for publish-time delivery.
--
-- A durable record is created in the same transaction as plan publication. A
-- later worker/provider integration can retry pending records without asking
-- the coach to re-publish an already published plan.

BEGIN;

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
