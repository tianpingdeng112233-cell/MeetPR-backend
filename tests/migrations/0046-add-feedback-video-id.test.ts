import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0046 feedback video association', () => {
  it('adds a nullable attachment reference and clears it when the video is deleted', () => {
    const mem = makeMigrationDb();
    mem.public.none(`
      CREATE TABLE attachments (id UUID PRIMARY KEY);
      CREATE TABLE feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        text TEXT NOT NULL
      );
      INSERT INTO feedback (text) VALUES ('Existing feedback');
    `);

    runMigration(mem, 'db/migrations/0046-add-feedback-video-id.sql');

    const existing = mem.public.one(
      `SELECT video_id FROM feedback WHERE text = 'Existing feedback'`,
    );
    expect(existing.video_id).toBeNull();

    const videoId = randomUUID();
    mem.public.none(`
      INSERT INTO attachments (id) VALUES ('${videoId}');
      INSERT INTO feedback (text, video_id) VALUES ('Video feedback', '${videoId}');
      DELETE FROM attachments WHERE id = '${videoId}';
    `);

    const linked = mem.public.one(`SELECT video_id FROM feedback WHERE text = 'Video feedback'`);
    expect(linked.video_id).toBeNull();
  });
});
