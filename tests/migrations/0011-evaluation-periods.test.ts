import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0011 evaluation periods', () => {
  it('enforces one active period per pair and completion consistency', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');
    runMigration(mem, 'db/migrations/0008-init-invite-codes.sql');
    runMigration(mem, 'db/migrations/0009-extend-bind-requests.sql');
    runMigration(mem, 'db/migrations/0011-init-evaluation-periods.sql');

    mem.public.none(`
      INSERT INTO bind_requests (id, student_id, coach_id, status, expired_at)
      VALUES (
        '30000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        'accepted', now()
      );

      INSERT INTO evaluation_periods (student_id, coach_id, bind_request_id, expected_end_at)
      VALUES (
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        now() + interval '7 days'
      );
    `);

    // Second active period for the same pair violates the partial index.
    expect(() => {
      mem.public.none(`
        INSERT INTO evaluation_periods (student_id, coach_id, bind_request_id, expected_end_at)
        VALUES (
          '10000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          now() + interval '7 days'
        );
      `);
    }).toThrow();

    // completed_at without completion_type violates the consistency CHECK.
    expect(() => {
      mem.public.none(`
        UPDATE evaluation_periods SET completed_at = now();
      `);
    }).toThrow();

    // Setting both passes and frees the active slot.
    mem.public.none(`
      UPDATE evaluation_periods SET completed_at = now(), completion_type = 'coach_completed';
      INSERT INTO evaluation_periods (student_id, coach_id, bind_request_id, expected_end_at)
      VALUES (
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        now() + interval '7 days'
      );
    `);

    // Cascade via bind_requests delete.
    mem.public.none(`DELETE FROM bind_requests WHERE id = '30000000-0000-4000-8000-000000000001';`);
    expect(mem.public.many(`SELECT * FROM evaluation_periods`)).toHaveLength(0);
  });
});
