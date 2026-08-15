import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('0067 digest watermarks', () => {
  it('stores one date watermark per coach and student and enforces both user references', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0067-digest-watermarks.sql');

    mem.public.none(`
      INSERT INTO digest_watermarks (coach_id, student_id, last_gym_day)
      VALUES (
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000003',
        DATE '2026-03-07'
      );
    `);

    expect(
      mem.public.one(`
        SELECT coach_id::text, student_id::text, last_gym_day
        FROM digest_watermarks;
      `),
    ).toEqual({
      coach_id: '10000000-0000-4000-8000-000000000001',
      student_id: '10000000-0000-4000-8000-000000000003',
      last_gym_day: new Date('2026-03-07T00:00:00.000Z'),
    });

    expect(() => {
      mem.public.none(`
        INSERT INTO digest_watermarks (coach_id, student_id, last_gym_day)
        VALUES (
          '10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000003',
          DATE '2026-03-08'
        );
      `);
    }).toThrow();
    expect(() => {
      mem.public.none(`
        INSERT INTO digest_watermarks (coach_id, student_id, last_gym_day)
        VALUES (
          '10000000-0000-4000-8000-000000000099',
          '10000000-0000-4000-8000-000000000003',
          DATE '2026-03-08'
        );
      `);
    }).toThrow();
    expect(() => {
      mem.public.none(`
        INSERT INTO digest_watermarks (coach_id, student_id, last_gym_day)
        VALUES (
          '10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000099',
          DATE '2026-03-08'
        );
      `);
    }).toThrow();
  });
});
