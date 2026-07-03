-- Migration 0029: first-party analytics events (behavioral observation layer).
-- One wide table + JSONB props. event_id is a client-generated uuid, UNIQUE on
-- the server so an at-least-once retry (lost 204 ack / killed flush) dedups to
-- exactly-once storage via ON CONFLICT(event_id) DO NOTHING. user_id is
-- SERVER-derived from the JWT (never trusted from the client body) and NULL for
-- pre-login events; ON DELETE SET NULL preserves the timeline shape after a user
-- deletion (the repo default CASCADE would erase history — do NOT use it here).
-- name is validated against a zod enum allowlist in the route (the real gate);
-- the column is plain text for forward-compat. props are ids/enums only — never
-- free text. ts_client is the untrusted device clock; reads tie-break on
-- (ts_client, ts_server, seq). Retention: 90d (documented; see SPEC §7).
-- Spec: specs/008-analytics-events/SPEC.md

BEGIN;

CREATE TABLE events (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID NOT NULL UNIQUE,
  anon_id        UUID NOT NULL,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  role           TEXT,
  session_id     UUID NOT NULL,
  seq            INT NOT NULL,
  name           TEXT NOT NULL,
  props          JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version SMALLINT NOT NULL DEFAULT 1,
  app_version    TEXT,
  build          TEXT,
  platform       TEXT NOT NULL DEFAULT 'ios',
  ts_client      TIMESTAMPTZ NOT NULL,
  ts_server      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-user story timeline (the core "感受" read), ordered by client clock.
CREATE INDEX events_user_ts_idx     ON events (user_id, ts_client);
-- one session as one story.
CREATE INDEX events_session_idx     ON events (session_id);
-- "功能使用排行榜" / funnel-by-event slices on server clock.
CREATE INDEX events_name_server_idx ON events (name, ts_server);
-- retention sweep + daily sanity window.
CREATE INDEX events_server_ts_idx   ON events (ts_server);

COMMIT;
