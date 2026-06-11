import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0012 student evaluations', () => {
  it('enforces one summary per pair and cascades versions on delete', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');
    runMigration(mem, 'db/migrations/0008-init-invite-codes.sql');
    runMigration(mem, 'db/migrations/0009-extend-bind-requests.sql');
    runMigration(mem, 'db/migrations/0011-init-evaluation-periods.sql');
    runMigration(mem, 'db/migrations/0012-init-student-evaluations.sql');

    mem.public.none(`
      INSERT INTO student_evaluations (id, student_id, coach_id, overall_assessment, training_plan)
      VALUES (
        '40000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        '整体评估', '训练规划'
      );

      INSERT INTO student_evaluation_versions (evaluation_id, overall_assessment, training_plan, notified_student)
      VALUES ('40000000-0000-4000-8000-000000000001', '整体评估', '训练规划', TRUE);
    `);

    // Second summary row for the same (student, coach) pair conflicts.
    expect(() => {
      mem.public.none(`
        INSERT INTO student_evaluations (student_id, coach_id, overall_assessment, training_plan)
        VALUES (
          '10000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000001',
          'x', 'y'
        );
      `);
    }).toThrow();

    // Empty required text violates the trim/length CHECK.
    expect(() => {
      mem.public.none(`
        INSERT INTO student_evaluations (student_id, coach_id, overall_assessment, training_plan)
        VALUES (
          '10000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000002',
          '   ', 'y'
        );
      `);
    }).toThrow();

    mem.public.none(
      `DELETE FROM student_evaluations WHERE id = '40000000-0000-4000-8000-000000000001';`,
    );
    expect(mem.public.many(`SELECT * FROM student_evaluation_versions`)).toHaveLength(0);
  });
});
