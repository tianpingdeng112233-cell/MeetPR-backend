import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

describe('migration 0006 feedback', () => {
  it('enforces trimmed text length and creates the unread partial index', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, 'db/migrations/0006-init-feedback.sql');

    expect(() => {
      mem.public.none(`
        INSERT INTO feedback (coach_id, student_id, text)
        VALUES (
          '10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000003',
          '   '
        );
      `);
    }).toThrow();

    mem.public.none(`
      INSERT INTO feedback (
        coach_id, student_id, day_date, plan_exercise_id, text
      ) VALUES (
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000003',
        '2026-05-15',
        '50000000-0000-4000-8000-000000000001',
        'Good work'
      );
    `);

    const migrationSql = fs.readFileSync('db/migrations/0006-init-feedback.sql', 'utf8');
    expect(mem.public.many('SELECT * FROM feedback')).toHaveLength(1);
    expect(migrationSql).toContain('CREATE INDEX feedback_student_unread_idx');
    expect(migrationSql).toContain('WHERE read_at IS NULL');
  });
});
