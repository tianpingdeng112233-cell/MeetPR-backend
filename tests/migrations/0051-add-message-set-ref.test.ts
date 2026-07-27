import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const COACH_ID = '10000000-0000-4000-8000-000000005101';
const STUDENT_ID = '10000000-0000-4000-8000-000000005102';
const CONVERSATION_ID = '20000000-0000-4000-8000-000000005101';
const ATTACHMENT_ID = '30000000-0000-4000-8000-000000005101';

function setup() {
  const mem = makeMigrationDb();
  runMigration(mem, 'db/migrations/0001-init-users.sql');
  mem.public.none(`
    CREATE TABLE attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      oss_key TEXT NOT NULL UNIQUE,
      oss_upload_id TEXT,
      content_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      filename TEXT,
      status TEXT NOT NULL DEFAULT 'uploading',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT attachments_kind_check
        CHECK (kind IN ('set_video', 'onboarding_video', 'onboarding_doc'))
    );
  `);
  runMigration(mem, 'db/migrations/0045-init-chat.sql');
  mem.public.none(`
    INSERT INTO users (id, phone, password_hash, role) VALUES
      ('${COACH_ID}', '+8613800055101', 'hash', 'coach'),
      ('${STUDENT_ID}', '+8613800055102', 'hash', 'coached_student');
    INSERT INTO conversations (id, coach_id, student_id)
    VALUES ('${CONVERSATION_ID}', '${COACH_ID}', '${STUDENT_ID}');
    INSERT INTO messages (conversation_id, seq, sender_id, kind, body, client_id)
    VALUES ('${CONVERSATION_ID}', 1, '${STUDENT_ID}', 'text', 'legacy', 'legacy-1');
  `);
  runMigration(mem, 'db/migrations/0051-add-message-set-ref.sql');
  return mem;
}

describe('migration 0051 message set references', () => {
  it('keeps legacy rows null and preserves the 0045 text/image mutual-exclusion check', () => {
    const mem = setup();

    expect(
      mem.public.one(
        `SELECT set_ref, video_id FROM messages WHERE conversation_id = '${CONVERSATION_ID}'`,
      ),
    ).toEqual({ set_ref: null, video_id: null });

    expect(() => {
      mem.public.none(`
        INSERT INTO messages (
          conversation_id, seq, sender_id, kind, body, client_id
        ) VALUES (
          '${CONVERSATION_ID}', 2, '${STUDENT_ID}', 'text', NULL, 'old-check'
        );
      `);
    }).toThrow(/check constraint|violates/i);
  });

  it('enforces both additive checks and clears video_id when its attachment is deleted', () => {
    const mem = setup();
    mem.public.none(`
      INSERT INTO attachments (
        id, owner_id, kind, oss_key, content_type, size_bytes, status
      ) VALUES (
        '${ATTACHMENT_ID}', '${STUDENT_ID}', 'set_video', 'set-video-0051',
        'video/mp4', 1, 'ready'
      );
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO messages (
          conversation_id, seq, sender_id, kind, body, attachment_id,
          set_ref, client_id
        ) VALUES (
          '${CONVERSATION_ID}', 2, '${STUDENT_ID}', 'image', NULL,
          '${ATTACHMENT_ID}', '{"v":1}', 'set-ref-image'
        );
      `);
    }).toThrow(/check constraint|violates/i);

    expect(() => {
      mem.public.none(`
        INSERT INTO messages (
          conversation_id, seq, sender_id, kind, body, video_id, client_id
        ) VALUES (
          '${CONVERSATION_ID}', 3, '${STUDENT_ID}', 'text', 'video only',
          '${ATTACHMENT_ID}', 'video-without-ref'
        );
      `);
    }).toThrow(/check constraint|violates/i);

    mem.public.none(`
      INSERT INTO messages (
        conversation_id, seq, sender_id, kind, body, set_ref, video_id, client_id
      ) VALUES (
        '${CONVERSATION_ID}', 4, '${STUDENT_ID}', 'text', 'valid',
        '{"v":1}', '${ATTACHMENT_ID}', 'valid-set-ref'
      );
      DELETE FROM attachments WHERE id = '${ATTACHMENT_ID}';
    `);

    expect(
      mem.public.one(`SELECT set_ref, video_id FROM messages WHERE client_id = 'valid-set-ref'`),
    ).toEqual({ set_ref: { v: 1 }, video_id: null });
  });

  it('creates the partial service index and leaves migration 0045 byte-for-byte untouched', () => {
    const mem = setup();
    const index = mem.public
      .getTable('messages')
      .listIndices()
      .find((candidate) => candidate.name === 'messages_video_id_idx');
    const sql = fs.readFileSync('db/migrations/0051-add-message-set-ref.sql', 'utf8');
    const oldSql = fs.readFileSync('db/migrations/0045-init-chat.sql', 'utf8');
    // Fixed checksum, not `git show HEAD`: once a commit lands, HEAD and the worktree agree
    // again, so a HEAD comparison can never catch a future commit that edits 0045. The pinned
    // digest is the applied-on-staging content of 0045 and must never change.
    expect(createHash('sha256').update(oldSql).digest('hex')).toBe(
      'c4059254a8a88ce60ec310bbe1c43756712714fa6d38ff75e9d2691a4f92fead',
    );

    expect(index).toMatchObject({
      name: 'messages_video_id_idx',
      expressions: ['video_id'],
      unique: false,
    });
    expect(sql).toMatch(
      /CREATE INDEX messages_video_id_idx\s+ON messages \(video_id\)\s+WHERE video_id IS NOT NULL/,
    );
  });
});
