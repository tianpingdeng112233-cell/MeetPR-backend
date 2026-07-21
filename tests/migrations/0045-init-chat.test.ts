import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

function setup() {
  const mem = makeMigrationDb();
  runMigration(mem, 'db/migrations/0001-init-users.sql');
  // pg-mem does not expose PostgreSQL's generated name for an inline CHECK,
  // so declare the production name explicitly before exercising DROP/ADD.
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
  return mem;
}

describe('migration 0045 chat', () => {
  it('creates the three chat tables with INTEGER sequence cursors and uniqueness', () => {
    const mem = setup();
    const columns = mem.public.many(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_name IN ('conversations', 'messages', 'conversation_reads')
    `) as { table_name: string; column_name: string; data_type: string }[];

    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: 'messages',
          column_name: 'seq',
          data_type: 'integer',
        }),
        expect.objectContaining({
          table_name: 'conversation_reads',
          column_name: 'last_read_seq',
          data_type: 'integer',
        }),
      ]),
    );

    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role) VALUES
        ('10000000-0000-4000-8000-000000000001', '+8613800045001', 'hash', 'coach'),
        ('10000000-0000-4000-8000-000000000002', '+8613800045002', 'hash', 'coached_student');
      INSERT INTO conversations (id, coach_id, student_id)
      VALUES (
        '20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002'
      );
      INSERT INTO messages (conversation_id, seq, sender_id, kind, body, client_id)
      VALUES (
        '20000000-0000-4000-8000-000000000001', 1,
        '10000000-0000-4000-8000-000000000001', 'text', 'hello', 'client-1'
      );
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO messages (conversation_id, seq, sender_id, kind, body, client_id)
        VALUES (
          '20000000-0000-4000-8000-000000000001', 1,
          '10000000-0000-4000-8000-000000000002', 'text', 'duplicate seq', 'client-2'
        );
      `);
    }).toThrow(/duplicate key|unique/i);
  });

  it('widens attachments_kind_check to accept chat_image without removing prior kinds', () => {
    const mem = setup();
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role)
      VALUES ('10000000-0000-4000-8000-000000000001', '+8613800045010', 'hash', 'coach');
    `);

    for (const [index, kind] of [
      'set_video',
      'onboarding_video',
      'onboarding_doc',
      'chat_image',
    ].entries()) {
      mem.public.none(`
        INSERT INTO attachments (
          owner_id, kind, oss_key, content_type, size_bytes, status
        ) VALUES (
          '10000000-0000-4000-8000-000000000001', '${kind}', 'key-${String(index)}',
          'application/octet-stream', 1, 'ready'
        );
      `);
    }

    expect(() => {
      mem.public.none(`
        INSERT INTO attachments (
          owner_id, kind, oss_key, content_type, size_bytes, status
        ) VALUES (
          '10000000-0000-4000-8000-000000000001', 'unknown', 'key-bad',
          'application/octet-stream', 1, 'ready'
        );
      `);
    }).toThrow(/check constraint|violates/i);
  });

  it('pins clock_timestamp defaults and the attachment CHECK replacement in SQL', () => {
    const sql = fs.readFileSync('db/migrations/0045-init-chat.sql', 'utf8');

    expect(sql).toMatch(/seq\s+INTEGER NOT NULL/);
    expect(sql).toMatch(/last_read_seq\s+INTEGER NOT NULL/);
    expect(sql).toMatch(/DEFAULT clock_timestamp\(\)/g);
    expect(sql).toContain('DROP CONSTRAINT attachments_kind_check');
    expect(sql).toContain("'onboarding_doc', 'chat_image'");
  });
});
