import { describe, expect, it } from 'vitest';
import { makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0078 exercise adoption', () => {
  it('is repeatable, preserves existing rows, and restricts target deletion', () => {
    const mem = makeMigrationDb();
    mem.public
      .none(`CREATE TABLE exercises (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL);
      INSERT INTO exercises (id, name) VALUES
      ('53000000-0000-4000-8000-000000000001', 'Official'),
      ('53000000-0000-4000-8000-000000000002', 'Alias');`);
    const before = mem.public.many('SELECT * FROM exercises ORDER BY id') as {
      id: string;
      name: string;
    }[];
    runMigration(mem, 'db/migrations/0078-exercise-adoption.sql');
    runMigration(mem, 'db/migrations/0078-exercise-adoption.sql');
    expect(mem.public.many('SELECT * FROM exercises ORDER BY id')).toEqual(
      before.map((row) => ({ ...row, canonical_exercise_id: null, adopted_at: null })),
    );
    mem.public.none(
      `UPDATE exercises SET canonical_exercise_id = '53000000-0000-4000-8000-000000000001' WHERE name = 'Alias'`,
    );
    expect(() => {
      mem.public.none(`DELETE FROM exercises WHERE name = 'Official'`);
    }).toThrow(/foreign key/i);
    expect(() => {
      mem.public.none(
        `UPDATE exercises SET canonical_exercise_id = '53000000-0000-4000-8000-000000000099' WHERE name = 'Alias'`,
      );
    }).toThrow(/foreign key/i);
  });
});
