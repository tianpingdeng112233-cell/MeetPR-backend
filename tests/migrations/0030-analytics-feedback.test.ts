import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const student = '10000000-0000-4000-8000-000000000003';

function insertFeedback(
  mem: ReturnType<typeof makeMigrationDb>,
  overrides: Partial<{ event_id: string; user_id: string | null; text: string }> = {},
): void {
  const row = {
    event_id: '99000000-0000-4000-8000-000000000001',
    user_id: null as string | null,
    text: '录组太麻烦了',
    ...overrides,
  };
  mem.public.none(`
    INSERT INTO analytics_feedback
      (event_id, anon_id, user_id, session_id, flow, from_screen, trigger, text, ts_client)
    VALUES (
      '${row.event_id}', 'aa000000-0000-4000-8000-000000000001',
      ${row.user_id === null ? 'NULL' : `'${row.user_id}'`},
      'bb000000-0000-4000-8000-000000000001',
      'record_set', 'today_workout', 're_edit', '${row.text}', '2026-06-24T19:03:11.000Z'
    );
  `);
}

describe('migration 0030 analytics_feedback', () => {
  it('rejects a duplicate event_id', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0030-init-analytics-feedback.sql');

    insertFeedback(mem);
    expect(() => {
      insertFeedback(mem, { text: 'again' });
    }).toThrow();
  });

  it('SET NULLs user_id on user delete but keeps the row', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0030-init-analytics-feedback.sql');

    insertFeedback(mem, { user_id: student });
    mem.public.none(`DELETE FROM users WHERE id = '${student}';`);

    const rows = mem.public.many('SELECT user_id FROM analytics_feedback');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
  });

  it('rejects a NULL text (free-text column is NOT NULL)', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0030-init-analytics-feedback.sql');

    expect(() => {
      mem.public.none(`
        INSERT INTO analytics_feedback
          (event_id, anon_id, session_id, flow, from_screen, trigger, ts_client)
        VALUES (
          '99000000-0000-4000-8000-000000000009',
          'aa000000-0000-4000-8000-000000000001',
          'bb000000-0000-4000-8000-000000000001',
          'record_set', 'today_workout', 're_edit', '2026-06-24T19:03:11.000Z'
        );
      `);
    }).toThrow();
  });
});
