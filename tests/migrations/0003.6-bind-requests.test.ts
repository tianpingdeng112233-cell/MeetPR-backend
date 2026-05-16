import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0003.6 bind requests', () => {
  it('uses a partial unique index for accepted bonds only and cascades user delete', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');

    mem.public.none(`
      INSERT INTO bind_requests (student_id, coach_id, status, expired_at)
      VALUES
        ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'pending', now()),
        ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'pending', now()),
        ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'accepted', now());
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO bind_requests (student_id, coach_id, status, expired_at)
        VALUES (
          '10000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000001',
          'accepted',
          now()
        );
      `);
    }).toThrow();

    mem.public.none(`
      DELETE FROM users WHERE id = '10000000-0000-4000-8000-000000000003';
    `);
    expect(mem.public.many('SELECT * FROM bind_requests')).toHaveLength(0);
  });
});
