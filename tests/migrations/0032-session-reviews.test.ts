import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const STUDENT = '10000000-0000-4000-8000-000000000003';

describe('migration 0032 session reviews', () => {
  it('creates the table with one-row-per-day uniqueness and content checks', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0032-init-session-reviews.sql');

    mem.public.none(`
      INSERT INTO session_reviews (student_id, review_date, feeling, session_rpe)
      VALUES ('${STUDENT}', '2026-07-04', '最后一组很稳', 8.5);
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO session_reviews (student_id, review_date, feeling)
        VALUES ('${STUDENT}', '2026-07-04', '同一天第二条');
      `);
    }).toThrow();

    expect(() => {
      mem.public.none(`
        INSERT INTO session_reviews (student_id, review_date, feeling)
        VALUES ('${STUDENT}', '2026-07-05', '   ');
      `);
    }).toThrow();

    const rows = mem.public.many(`SELECT feeling FROM session_reviews;`);
    expect(rows).toHaveLength(1);
  });
});
