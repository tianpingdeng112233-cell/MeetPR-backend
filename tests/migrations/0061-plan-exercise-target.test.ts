import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0061-plan-exercise-target.sql';

function createPre0061Schema(mem: ReturnType<typeof makeMigrationDb>): void {
  mem.public.none(`
    CREATE TABLE plan_exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      notes TEXT
    );

    INSERT INTO plan_exercises (notes) VALUES ('legacy row');
  `);
}

describe('migration 0061 plan exercise target', () => {
  it('adds a nullable column, keeps existing rows NULL, and enforces the token shape', () => {
    const mem = makeMigrationDb();
    createPre0061Schema(mem);
    runMigration(mem, MIGRATION);

    expect(mem.public.one(`SELECT target FROM plan_exercises;`)).toEqual({ target: null });
    mem.public.none(`UPDATE plan_exercises SET target = 'squat';`);
    mem.public.none(`UPDATE plan_exercises SET target = 'hamstring';`);
    expect(() => {
      mem.public.none(`UPDATE plan_exercises SET target = '${'x'.repeat(33)}';`);
    }).toThrow();
  });
});
