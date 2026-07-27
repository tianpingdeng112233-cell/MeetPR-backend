import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const coachId = '10000000-0000-4000-8000-000000000001';
const studentId = '10000000-0000-4000-8000-000000000003';
const videoId = '20000000-0000-4000-8000-000000000051';

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  mem.public.none(`
    CREATE TABLE attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO attachments (id, owner_id) VALUES ('${videoId}', '${studentId}');
  `);
  runMigration(mem, 'db/migrations/0051-video-markers.sql');
  return mem;
}

describe('migration 0051 video markers', () => {
  it('creates marker defaults and enforces time, level, and note checks', () => {
    const mem = setup();
    const noteAtLimit = 'n'.repeat(500);
    const noteOverLimit = 'n'.repeat(501);

    mem.public.none(`
      INSERT INTO video_markers (video_id, coach_id, time_ms)
      VALUES ('${videoId}', '${coachId}', 1500);
      INSERT INTO video_markers (video_id, coach_id, time_ms, note)
      VALUES ('${videoId}', '${coachId}', 1600, '${noteAtLimit}');
    `);
    const marker = mem.public.one(`
      SELECT video_id, coach_id, time_ms, level, note, created_at
      FROM video_markers
      WHERE time_ms = 1500
    `);
    expect(marker).toMatchObject({
      video_id: videoId,
      coach_id: coachId,
      time_ms: 1500,
      level: 'info',
      note: '',
    });
    expect(marker.created_at).toBeInstanceOf(Date);

    expect(() => {
      mem.public.none(`
        INSERT INTO video_markers (video_id, coach_id, time_ms)
        VALUES ('${videoId}', '${coachId}', -1);
      `);
    }).toThrow(/check constraint|violates/i);
    expect(() => {
      mem.public.none(`
        INSERT INTO video_markers (video_id, coach_id, time_ms, level)
        VALUES ('${videoId}', '${coachId}', 0, 'urgent');
      `);
    }).toThrow(/check constraint|violates/i);
    expect(() => {
      mem.public.none(`
        INSERT INTO video_markers (video_id, coach_id, time_ms, note)
        VALUES ('${videoId}', '${coachId}', 0, '${noteOverLimit}');
      `);
    }).toThrow(/check constraint|violates/i);
  });

  it('cascades markers when their attachment is deleted', () => {
    const mem = setup();
    mem.public.none(`
      INSERT INTO video_markers (video_id, coach_id, time_ms, level, note)
      VALUES ('${videoId}', '${coachId}', 2500, 'bad', 'Depth');
      DELETE FROM attachments WHERE id = '${videoId}';
    `);

    expect(mem.public.one(`SELECT count(*)::int AS count FROM video_markers`).count).toBe(0);
  });

  it('pins the public search path and video-time index in SQL', () => {
    const sql = fs.readFileSync('db/migrations/0051-video-markers.sql', 'utf8');

    expect(sql).toMatch(/BEGIN;\s+SET search_path TO public;/);
    expect(sql).toMatch(
      /CREATE INDEX video_markers_video_time_idx\s+ON video_markers \(video_id, time_ms\)/,
    );
  });
});
