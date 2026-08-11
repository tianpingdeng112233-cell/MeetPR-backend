import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb } from '../helpers/migrations';

const reviewedByFeedbackId = '20000000-0000-4000-8000-000000000061';
const reviewedByMarkerId = '20000000-0000-4000-8000-000000000062';
const pendingId = '20000000-0000-4000-8000-000000000063';
const alreadyViewedId = '20000000-0000-4000-8000-000000000064';

function setup() {
  const mem = makeMigrationDb();
  mem.public.none(`
    CREATE TABLE attachments (
      id UUID PRIMARY KEY,
      coach_viewed_at TIMESTAMPTZ
    );
    CREATE TABLE feedback (
      video_id UUID,
      posted_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE video_markers (
      video_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    INSERT INTO attachments (id, coach_viewed_at) VALUES
      ('${reviewedByFeedbackId}', NULL),
      ('${reviewedByMarkerId}', NULL),
      ('${pendingId}', NULL),
      ('${alreadyViewedId}', '2026-07-01T00:00:00Z');

    INSERT INTO feedback (video_id, posted_at) VALUES
      ('${reviewedByFeedbackId}', '2026-08-03T12:00:00Z'),
      ('${reviewedByFeedbackId}', '2026-08-02T12:00:00Z'),
      ('${reviewedByMarkerId}', '2026-08-06T12:00:00Z'),
      ('${alreadyViewedId}', '2026-06-01T00:00:00Z'),
      (NULL, '2026-01-01T00:00:00Z');

    INSERT INTO video_markers (video_id, created_at) VALUES
      ('${reviewedByFeedbackId}', '2026-08-01T12:00:00Z'),
      ('${reviewedByMarkerId}', '2026-08-05T12:00:00Z');
  `);
  return mem;
}

describe('migration 0062 video coach viewed', () => {
  it('pins the additive column, public search path, and both physical review sources', () => {
    const migration = fs.readFileSync('db/migrations/0062-video-coach-viewed.sql', 'utf8');

    expect(migration).toMatch(/^BEGIN;\s+SET search_path TO public;/);
    expect(migration).toContain('ADD COLUMN coach_viewed_at TIMESTAMPTZ;');
    expect(migration).toContain(
      'SELECT video_id, posted_at AS created FROM feedback WHERE video_id IS NOT NULL',
    );
    expect(migration).toContain(
      'UNION ALL\n    SELECT video_id, created_at AS created FROM video_markers',
    );
    expect(migration).toContain('SELECT video_id, MIN(created) AS first_reviewed');
    expect(migration).toContain('AND a.coach_viewed_at IS NULL;');
  });

  it('backfills the earliest feedback or marker and preserves existing review times', () => {
    const mem = setup();

    // pg-mem rejects the production-valid UPDATE ... FROM target alias with
    // "Unknown alias attachments". Execute the same aggregate and guarded
    // per-row writes here; the test above pins the production SQL verbatim.
    const firstReviews = mem.public.many(`
      SELECT video_id, MIN(created) AS first_reviewed
      FROM (
        SELECT video_id, posted_at AS created FROM feedback WHERE video_id IS NOT NULL
        UNION ALL
        SELECT video_id, created_at AS created FROM video_markers
      ) events
      GROUP BY video_id
    `) as { video_id: string; first_reviewed: Date }[];
    for (const event of firstReviews) {
      mem.public.none(`
        UPDATE attachments
        SET coach_viewed_at = '${event.first_reviewed.toISOString()}'
        WHERE id = '${event.video_id}'
          AND coach_viewed_at IS NULL
      `);
    }

    const rows = mem.public.many(`
      SELECT id, coach_viewed_at FROM attachments ORDER BY id
    `) as { id: string; coach_viewed_at: Date | null }[];
    expect(rows).toEqual([
      {
        id: reviewedByFeedbackId,
        coach_viewed_at: new Date('2026-08-01T12:00:00Z'),
      },
      {
        id: reviewedByMarkerId,
        coach_viewed_at: new Date('2026-08-05T12:00:00Z'),
      },
      { id: pendingId, coach_viewed_at: null },
      {
        id: alreadyViewedId,
        coach_viewed_at: new Date('2026-07-01T00:00:00Z'),
      },
    ]);
  });
});
