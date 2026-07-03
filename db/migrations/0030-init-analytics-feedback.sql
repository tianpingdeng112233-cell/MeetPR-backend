-- Migration 0030: qualitative friction feedback (the ONE free-text path).
-- Physically separate from `events` (events stays free-text-free — true gate).
-- `text` is the only free-text column in the analytics surface; capped, and this
-- table carries a PIPL content-class declaration (User Content) that `events`
-- does not. Joins back to the friction_feedback signal event by event_id.
-- Spec: specs/008-analytics-events/SPEC.md §4b
BEGIN;
CREATE TABLE analytics_feedback (
  id          BIGSERIAL PRIMARY KEY,
  event_id    UUID NOT NULL UNIQUE,          -- = the friction_feedback signal event's id (join key)
  anon_id     UUID NOT NULL,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id  UUID NOT NULL,
  flow        TEXT NOT NULL,                 -- enum-validated in route
  from_screen TEXT NOT NULL,                 -- enum-validated in route
  trigger     TEXT NOT NULL,                 -- re_edit | flow_cancel
  text        TEXT NOT NULL,                 -- the user's sentence; capped <=500 chars in zod
  app_version TEXT,
  build       TEXT,
  ts_client   TIMESTAMPTZ NOT NULL,
  ts_server   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analytics_feedback_user_ts_idx ON analytics_feedback (user_id, ts_client);
CREATE INDEX analytics_feedback_server_ts_idx ON analytics_feedback (ts_server);
COMMIT;
