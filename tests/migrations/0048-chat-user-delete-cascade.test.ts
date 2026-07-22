import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0048-chat-user-delete-cascade.sql';

/// The five FKs 0048 rewrites, in the order the file touches them. Each is a
/// name PostgreSQL generated for an inline `REFERENCES users(id)`; pg-mem does
/// not generate those names, so the fixture below declares them explicitly
/// (same technique as the 0045 test does for `attachments_kind_check`).
const REWRITTEN = [
  'conversations_coach_id_fkey',
  'conversations_student_id_fkey',
  'messages_sender_id_fkey',
  'conversation_reads_user_id_fkey',
  'plan_day_shifts_student_id_fkey',
];

function setup() {
  const mem = makeMigrationDb();
  runMigration(mem, 'db/migrations/0001-init-users.sql');
  // Pre-0048 shape: the users FKs are plain REFERENCES (NO ACTION), which is
  // exactly what 0045 / 0037 created and what made DELETE /me return 500.
  mem.public.none(`
    CREATE TABLE conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id UUID NOT NULL CONSTRAINT conversations_coach_id_fkey REFERENCES users(id),
      student_id UUID NOT NULL CONSTRAINT conversations_student_id_fkey REFERENCES users(id)
    );

    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL CONSTRAINT messages_sender_id_fkey REFERENCES users(id),
      body TEXT NOT NULL
    );

    CREATE TABLE conversation_reads (
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL CONSTRAINT conversation_reads_user_id_fkey REFERENCES users(id),
      last_read_seq INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL CONSTRAINT plan_day_shifts_student_id_fkey REFERENCES users(id),
      shifted_to_date DATE NOT NULL
    );
  `);
  return mem;
}

function seedConversation(mem: ReturnType<typeof makeMigrationDb>) {
  mem.public.none(`
    INSERT INTO users (id, phone, password_hash, role)
    VALUES
      ('11111111-1111-1111-1111-111111111111', '13800000001', 'x', 'coach'),
      ('22222222-2222-2222-2222-222222222222', '13800000002', 'x', 'coached_student');

    INSERT INTO conversations (id, coach_id, student_id)
    VALUES (
      '33333333-3333-3333-3333-333333333333',
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222'
    );

    INSERT INTO messages (conversation_id, sender_id, body)
    VALUES
      ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'hi'),
      ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'hello');

    INSERT INTO conversation_reads (conversation_id, user_id, last_read_seq)
    VALUES
      ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 2),
      ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 2);

    INSERT INTO plan_day_shifts (student_id, shifted_to_date)
    VALUES ('22222222-2222-2222-2222-222222222222', DATE '2026-07-22');
  `);
}

describe('migration 0048 chat user-delete cascade', () => {
  it('lets a bare DELETE FROM users clear a chat member in one statement', () => {
    const mem = setup();
    seedConversation(mem);

    runMigration(mem, MIGRATION);

    // The whole point: DELETE /me is `DELETE FROM users WHERE id = ?` and
    // relies entirely on the FK graph. Before 0048 this raised 23503.
    mem.public.none(`DELETE FROM users WHERE id = '22222222-2222-2222-2222-222222222222'`);

    expect(mem.public.many('SELECT id FROM conversations')).toHaveLength(0);
    expect(mem.public.many('SELECT id FROM messages')).toHaveLength(0);
    expect(mem.public.many('SELECT user_id FROM conversation_reads')).toHaveLength(0);
    expect(mem.public.many('SELECT id FROM plan_day_shifts')).toHaveLength(0);
  });

  it('takes the thread down with the coach too, not just the student', () => {
    const mem = setup();
    seedConversation(mem);

    runMigration(mem, MIGRATION);

    mem.public.none(`DELETE FROM users WHERE id = '11111111-1111-1111-1111-111111111111'`);

    // conversations.coach_id cascades, and messages / conversation_reads follow
    // through conversation_id — an account deletion must not leave the deleted
    // user's messages sitting in the other party's inbox.
    expect(mem.public.many('SELECT id FROM conversations')).toHaveLength(0);
    expect(mem.public.many('SELECT id FROM messages')).toHaveLength(0);
    expect(mem.public.many('SELECT user_id FROM conversation_reads')).toHaveLength(0);
  });

  it('rewrites every users FK the chat and shift tables left at NO ACTION', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    for (const constraint of REWRITTEN) {
      expect(sql).toContain(`DROP CONSTRAINT ${constraint}`);
      expect(sql).toContain(`ADD CONSTRAINT ${constraint}`);
    }
    // Every re-added constraint must carry an explicit action; a silent
    // re-add would reintroduce the exact NO ACTION default 0048 exists to kill.
    expect(sql.match(/ON DELETE CASCADE/g) ?? []).toHaveLength(REWRITTEN.length);
  });
});
