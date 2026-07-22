-- Migration 0048: give the chat tables' users FKs an explicit ON DELETE action.
--
-- DELETE /me (spec 011 §1, Apple 5.1.1(v)) is a bare `DELETE FROM users WHERE
-- id = ?` and relies entirely on the FK graph to clear the user's rows. The
-- 0045 chat tables were created with plain `REFERENCES users(id)` — i.e. NO
-- ACTION — so a coached_student who has ever opened a conversation, sent a
-- message, or marked a thread read hits 23503 and gets a 500 instead of 204.
--
-- Semantics chosen (spec 024 is a strict 1:1 coach<->student thread):
--
--   conversations.coach_id / .student_id -> CASCADE. Both members are NOT NULL
--     and the read path resolves the other party through users, so there is no
--     "surviving thread with a tombstoned member" shape to fall back to. The
--     thread dies with either member. That is also the privacy-correct answer:
--     an account deletion must not leave the deleted user's messages sitting in
--     the other party's inbox.
--
--   messages.sender_id -> CASCADE. Today every sender is a member of the
--     conversation, so the conversations cascade above already removes these
--     rows via messages.conversation_id and NO ACTION would happen to pass its
--     end-of-statement recheck. Making it explicit removes the dependency on
--     that app-level invariant (a future system/broadcast sender would silently
--     re-break DELETE /me) and on cascade evaluation order.
--
--   conversation_reads.user_id -> CASCADE. A per-user read cursor is pure
--     derived state; it has no meaning without its user.
--
-- plan_day_shifts.student_id (migration 0037) is the same omission and is fixed
-- here too: it is currently unreachable only because plans.trainee_id RESTRICT
-- fails first. See the note at the bottom of this file.

BEGIN;

ALTER TABLE conversations
  DROP CONSTRAINT conversations_coach_id_fkey;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_coach_id_fkey
  FOREIGN KEY (coach_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE conversations
  DROP CONSTRAINT conversations_student_id_fkey;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE messages
  DROP CONSTRAINT messages_sender_id_fkey;

ALTER TABLE messages
  ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE conversation_reads
  DROP CONSTRAINT conversation_reads_user_id_fkey;

ALTER TABLE conversation_reads
  ADD CONSTRAINT conversation_reads_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE plan_day_shifts
  DROP CONSTRAINT plan_day_shifts_student_id_fkey;

ALTER TABLE plan_day_shifts
  ADD CONSTRAINT plan_day_shifts_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE;

COMMIT;

-- NOT fixed here, deliberately: `plans.trainee_id` is ON DELETE RESTRICT
-- (migration 0003), so DELETE /me still returns 500 for any student who has a
-- plan — which is every real coached student. Unpicking it also has to answer
-- `attachments.source_plan_id` / `.source_coach_id` RESTRICT (migration 0035),
-- and RESTRICT — unlike NO ACTION — fires even when the referencing row is
-- being removed by a sibling cascade in the same statement. That is a separate
-- data-retention decision about the coach's authored plans, not a chat fix.
