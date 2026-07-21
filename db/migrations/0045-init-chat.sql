-- Migration 0045: coach <-> student 1:1 chat (W1 REST messaging).
-- Spec: specs/024-coach-student-chat/SPEC.md

BEGIN;

CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id        UUID NOT NULL REFERENCES users(id),
  student_id      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_message_at TIMESTAMPTZ,
  UNIQUE (coach_id, student_id)
);

CREATE INDEX conversations_coach_idx
  ON conversations (coach_id, last_message_at DESC);

CREATE INDEX conversations_student_idx
  ON conversations (student_id, last_message_at DESC);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  sender_id       UUID NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  body            TEXT,
  attachment_id   UUID REFERENCES attachments(id),
  client_id       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (kind = 'text' AND body IS NOT NULL AND attachment_id IS NULL)
    OR (kind = 'image' AND attachment_id IS NOT NULL AND body IS NULL)
  ),
  CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000),
  CHECK (length(client_id) BETWEEN 1 AND 64),
  UNIQUE (conversation_id, sender_id, client_id),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX messages_conversation_seq_idx
  ON messages (conversation_id, seq);

CREATE TABLE conversation_reads (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id),
  last_read_seq    INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE attachments
  DROP CONSTRAINT attachments_kind_check;

ALTER TABLE attachments
  ADD CONSTRAINT attachments_kind_check
  CHECK (kind IN ('set_video', 'onboarding_video', 'onboarding_doc', 'chat_image'));

COMMIT;
