import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const coachId = '10000000-0000-4000-8000-000000000001';
const studentId = '10000000-0000-4000-8000-000000000003';
const videoId = '20000000-0000-4000-8000-000000000051';
const annotationId = '20000000-0000-4000-8000-000000000052';

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  mem.public.none(`
    CREATE TABLE attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO attachments (id, owner_id) VALUES
      ('${videoId}', '${studentId}'),
      ('${annotationId}', '${coachId}');
  `);
  runMigration(mem, 'db/migrations/0054-video-markers.sql');
  runMigration(mem, 'db/migrations/0055-marker-annotation-attachment.sql');
  // Idempotent: DMS 半途重跑不炸。
  runMigration(mem, 'db/migrations/0055-marker-annotation-attachment.sql');
  return mem;
}

describe('migration 0055 marker annotation attachment', () => {
  it('adds a nullable attachment reference and preserves it on insert', () => {
    const mem = setup();

    mem.public.none(`
      INSERT INTO video_markers (video_id, coach_id, attachment_id, time_ms)
      VALUES ('${videoId}', '${coachId}', '${annotationId}', 1500);
    `);

    expect(mem.public.one(`SELECT attachment_id FROM video_markers WHERE time_ms = 1500`)).toEqual({
      attachment_id: annotationId,
    });
    expect(() => {
      mem.public.none(`
        INSERT INTO video_markers (video_id, coach_id, attachment_id, time_ms)
        VALUES ('${videoId}', '${coachId}', gen_random_uuid(), 1600);
      `);
    }).toThrow(/foreign key|constraint/i);
  });

  it('sets the marker attachment to null without deleting the marker', () => {
    const mem = setup();
    mem.public.none(`
      INSERT INTO video_markers (video_id, coach_id, attachment_id, time_ms)
      VALUES ('${videoId}', '${coachId}', '${annotationId}', 2500);
      DELETE FROM attachments WHERE id = '${annotationId}';
    `);

    expect(mem.public.one(`SELECT attachment_id FROM video_markers WHERE time_ms = 2500`)).toEqual({
      attachment_id: null,
    });
  });

  it('pins the approved SQL exactly', () => {
    const sql = fs.readFileSync('db/migrations/0055-marker-annotation-attachment.sql', 'utf8');

    expect(sql).toBe(`BEGIN;
SET search_path TO public;
ALTER TABLE video_markers
  ADD COLUMN IF NOT EXISTS attachment_id UUID NULL REFERENCES attachments(id) ON DELETE SET NULL;
COMMIT;
`);
  });
});
