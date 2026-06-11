import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0009 extend bind requests', () => {
  it('adds invite_code_id (SET NULL on code delete) and skip_reason', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');
    runMigration(mem, 'db/migrations/0008-init-invite-codes.sql');
    runMigration(mem, 'db/migrations/0009-extend-bind-requests.sql');

    mem.public.none(`
      INSERT INTO invite_codes (id, coach_id, code, type)
      VALUES ('20000000-0000-4000-8000-000000000099', '10000000-0000-4000-8000-000000000001', 'AAAAAAAAAA', 'single_use');

      INSERT INTO bind_requests (student_id, coach_id, status, expired_at, invite_code_id, skip_reason)
      VALUES (
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        'accepted',
        now(),
        '20000000-0000-4000-8000-000000000099',
        '已带过的学员'
      );
    `);

    // Deleting the invite code keeps the bind request, nulling the linkage.
    mem.public.none(`DELETE FROM invite_codes WHERE id = '20000000-0000-4000-8000-000000000099';`);
    const rows = mem.public.many(`SELECT invite_code_id, skip_reason FROM bind_requests`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invite_code_id).toBeNull();
    expect(rows[0]?.skip_reason).toBe('已带过的学员');
  });
});
