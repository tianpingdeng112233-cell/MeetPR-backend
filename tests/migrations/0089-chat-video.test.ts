import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

function setup() {
  const mem = makeMigrationDb();
  mem.public.none(`
    CREATE TABLE attachments (id uuid PRIMARY KEY, kind text NOT NULL,
      CONSTRAINT attachments_kind_check CHECK (kind IN ('set_video', 'onboarding_video', 'onboarding_doc', 'chat_image')));
    CREATE TABLE messages (id integer PRIMARY KEY, kind text NOT NULL, body text,
      set_ref jsonb, video_id uuid REFERENCES attachments(id),
      CONSTRAINT messages_video_needs_set_ref CHECK (video_id IS NULL OR set_ref IS NOT NULL));
    INSERT INTO attachments VALUES ('30000000-0000-4000-8000-000000000001', 'set_video');
    INSERT INTO messages VALUES (1, 'text', 'legacy', null, null);
    INSERT INTO messages VALUES (2, 'text', 'shared set', '{"v":1}', '30000000-0000-4000-8000-000000000001');
  `);
  runMigration(mem, 'db/migrations/0086-add-message-exercise-ref.sql');
  return mem;
}

describe('migration 0089 chat video', () => {
  it('preserves old rows and accepts a standalone video without allowing image or exercise-note video hybrids', () => {
    const mem = setup();
    const before = mem.public.many('SELECT * FROM messages');
    const attachments = mem.public.many('SELECT * FROM attachments');
    runMigration(mem, 'db/migrations/0089-chat-video.sql');
    expect(mem.public.many('SELECT * FROM messages')).toEqual(before);
    expect(mem.public.many('SELECT * FROM attachments')).toEqual(attachments);
    mem.public
      .none(`INSERT INTO attachments VALUES ('30000000-0000-4000-8000-000000000002', 'chat_video');
      INSERT INTO messages VALUES (3, 'text', '[视频]', null, '30000000-0000-4000-8000-000000000002', null)`);
    expect(mem.public.one('SELECT kind, body, set_ref FROM messages WHERE id=3')).toEqual({
      kind: 'text',
      body: '[视频]',
      set_ref: null,
    });
    for (const values of [
      `(4, 'image', null, null, '30000000-0000-4000-8000-000000000002', null)`,
      `(5, 'text', 'note', null, '30000000-0000-4000-8000-000000000002', '{"v":1}')`,
    ])
      expect(() => {
        mem.public.none(`INSERT INTO messages VALUES ${values}`);
      }).toThrow(/check constraint|violates/i);
    expect(() => {
      mem.public.none(
        `INSERT INTO attachments VALUES ('30000000-0000-4000-8000-000000000003', 'arbitrary')`,
      );
    }).toThrow(/check constraint|violates/i);
  });
});
