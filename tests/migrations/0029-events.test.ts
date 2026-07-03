import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const student = '10000000-0000-4000-8000-000000000003';

function insertEvent(
  mem: ReturnType<typeof makeMigrationDb>,
  overrides: Partial<{
    event_id: string;
    anon_id: string;
    user_id: string | null;
    session_id: string;
    seq: number;
    name: string;
  }> = {},
): void {
  const row = {
    event_id: '99000000-0000-4000-8000-000000000001',
    anon_id: 'aa000000-0000-4000-8000-000000000001',
    user_id: null as string | null,
    session_id: 'bb000000-0000-4000-8000-000000000001',
    seq: 0,
    name: 'app_open',
    ...overrides,
  };
  mem.public.none(`
    INSERT INTO events (event_id, anon_id, user_id, session_id, seq, name, ts_client)
    VALUES (
      '${row.event_id}', '${row.anon_id}',
      ${row.user_id === null ? 'NULL' : `'${row.user_id}'`},
      '${row.session_id}', ${String(row.seq)}, '${row.name}', '2026-06-24T19:03:11.000Z'
    );
  `);
}

describe('migration 0029 events', () => {
  it('rejects a duplicate event_id (exactly-once storage)', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0029-init-events.sql');

    insertEvent(mem);
    expect(() => {
      insertEvent(mem, { seq: 1 });
    }).toThrow();
  });

  it('SET NULLs user_id on user delete but keeps the row (timeline survives)', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0029-init-events.sql');

    insertEvent(mem, { user_id: student });

    mem.public.none(`DELETE FROM users WHERE id = '${student}';`);

    const rows = mem.public.many('SELECT user_id FROM events');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
  });

  it('defaults props to {}, platform to ios, schema_version to 1', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0029-init-events.sql');

    insertEvent(mem);

    const rows = mem.public.many('SELECT props, platform, schema_version FROM events');
    expect(rows).toHaveLength(1);
    expect(rows[0].props).toEqual({});
    expect(rows[0].platform).toBe('ios');
    expect(rows[0].schema_version).toBe(1);
  });
});
