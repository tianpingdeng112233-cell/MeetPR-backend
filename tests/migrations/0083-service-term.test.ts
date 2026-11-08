import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0083 service term', () => {
  it.each([false, true])('runs twice and preserves existing bonds (populated=%s)', (populated) => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');
    if (populated) {
      mem.public.none(`INSERT INTO bind_requests (coach_id, student_id, status, expired_at)
        VALUES ('10000000-0000-4000-8000-000000000001',
                '10000000-0000-4000-8000-000000000003', 'accepted', '2026-12-01T00:00:00Z')`);
    }
    const before = mem.public.many('SELECT * FROM bind_requests') as Record<string, unknown>[];
    const migrate = () => {
      runMigration(mem, 'db/migrations/0083-service-term.sql');
    };
    migrate();
    migrate();
    expect(mem.public.many('SELECT * FROM bind_requests')).toEqual(
      before.map((row) => ({ ...row, service_until: null })),
    );
    mem.public
      .none(`INSERT INTO bind_requests (coach_id, student_id, status, expired_at, service_until)
      VALUES ('10000000-0000-4000-8000-000000000001',
              '10000000-0000-4000-8000-000000000003', 'pending', now(), '2027-02-28')`);
    const withTerm = mem.public.many('SELECT * FROM bind_requests');
    migrate();
    expect(mem.public.many('SELECT * FROM bind_requests')).toEqual(withTerm);
  });
});
