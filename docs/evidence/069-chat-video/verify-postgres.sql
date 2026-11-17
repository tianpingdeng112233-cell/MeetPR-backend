\set ON_ERROR_STOP on
CREATE TABLE users (id uuid PRIMARY KEY);
CREATE TABLE attachments (id uuid PRIMARY KEY, owner_id uuid REFERENCES users(id), kind text NOT NULL,
CONSTRAINT attachments_kind_check CHECK (kind IN ('set_video','onboarding_video','onboarding_doc')));
\ir ../../../db/migrations/0045-init-chat.sql
\ir ../../../db/migrations/0051-add-message-set-ref.sql
\ir ../../../db/migrations/0086-add-message-exercise-ref.sql
INSERT INTO users VALUES ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
INSERT INTO conversations(id,coach_id,student_id) VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
INSERT INTO attachments VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','set_video');
INSERT INTO messages(conversation_id,seq,sender_id,kind,body,client_id,video_id,set_ref)
VALUES ('20000000-0000-4000-8000-000000000001',1,'10000000-0000-4000-8000-000000000002','text','legacy set','legacy-set','30000000-0000-4000-8000-000000000001','{"v":1}');
CREATE TEMP TABLE old_messages AS SELECT * FROM messages;
CREATE TEMP TABLE old_attachments AS SELECT * FROM attachments;
\ir ../../../db/migrations/0089-chat-video.sql
DO $$ BEGIN
IF EXISTS ((SELECT * FROM messages EXCEPT SELECT * FROM old_messages) UNION ALL (SELECT * FROM old_messages EXCEPT SELECT * FROM messages)) THEN RAISE EXCEPTION 'old messages changed'; END IF;
IF EXISTS ((SELECT * FROM attachments EXCEPT SELECT * FROM old_attachments) UNION ALL (SELECT * FROM old_attachments EXCEPT SELECT * FROM attachments)) THEN RAISE EXCEPTION 'old attachments changed'; END IF;
END $$;
INSERT INTO attachments VALUES ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','chat_video');
INSERT INTO messages(conversation_id,seq,sender_id,kind,body,client_id,video_id)
VALUES ('20000000-0000-4000-8000-000000000001',2,'10000000-0000-4000-8000-000000000002','text','[视频]','standalone','30000000-0000-4000-8000-000000000002');
DO $$ BEGIN
BEGIN
 UPDATE messages SET exercise_ref='{"v":1}' WHERE client_id='standalone';
 RAISE EXCEPTION 'exercise video combination wrongly accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
BEGIN
 UPDATE messages SET kind='video' WHERE client_id='standalone';
 RAISE EXCEPTION 'new wire kind wrongly accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
END $$;
SELECT version();
SELECT kind, body, set_ref IS NULL AS independent, video_id IS NOT NULL AS has_video FROM messages ORDER BY seq;
