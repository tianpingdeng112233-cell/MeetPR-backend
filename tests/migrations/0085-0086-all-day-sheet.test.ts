import { describe, expect, it } from 'vitest';
import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

describe('SPEC 065 additive migrations', () => {
  it('preserves existing set rows and weights, then accepts null', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, 'db/migrations/0005-init-set-logs.sql');
    mem.public
      .none(`INSERT INTO set_logs (student_id, plan_exercise_id, set_index, weight_kg, reps, completed)
      VALUES ('10000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', 0, 102.5, 5, true)`);
    const before = mem.public.many('SELECT * FROM set_logs');
    runMigration(mem, 'db/migrations/0085-set-log-weight-nullable.sql');
    expect(mem.public.many('SELECT * FROM set_logs')).toEqual(before);
    mem.public
      .none(`INSERT INTO set_logs (student_id, plan_exercise_id, set_index, weight_kg, reps, completed)
      VALUES ('10000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', 1, null, 5, true)`);
    expect(mem.public.one('SELECT weight_kg FROM set_logs WHERE set_index = 1')).toEqual({
      weight_kg: null,
    });
  });

  it('preserves old messages and enforces exercise-reference constraints in SQL', () => {
    const mem = makeMigrationDb();
    // Minimal pre-migration table isolates the three additive checks from old attachment checks.
    mem.public.none(`CREATE TABLE messages (id integer PRIMARY KEY, kind text NOT NULL, body text,
      set_ref jsonb, video_id uuid);
      INSERT INTO messages VALUES (1, 'text', 'legacy', null, null)`);
    runMigration(mem, 'db/migrations/0086-add-message-exercise-ref.sql');
    expect(mem.public.one('SELECT * FROM messages')).toEqual({
      id: 1,
      kind: 'text',
      body: 'legacy',
      set_ref: null,
      video_id: null,
      exercise_ref: null,
    });
    for (const values of [
      `(2, 'image', null, null, null, '{"v":1}')`,
      `(3, 'text', 'note', '{"v":1}', null, '{"v":1}')`,
      `(4, 'text', 'note', null, '50000000-0000-4000-8000-000000000001', '{"v":1}')`,
    ])
      expect(() => {
        mem.public.none(`INSERT INTO messages VALUES ${values}`);
      }).toThrow(/check constraint|violates/i);
    mem.public.none(`INSERT INTO messages VALUES (5, 'text', 'note', null, null, '{"v":1}')`);
    expect(mem.public.many('SELECT id FROM messages')).toHaveLength(2);
  });
});
