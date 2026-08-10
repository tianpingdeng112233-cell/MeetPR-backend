import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0060-plan-anchor-weekday.sql';

function createPre0060Schema(mem: ReturnType<typeof makeMigrationDb>): void {
  mem.public.none(`
    CREATE TABLE plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL
    );

    INSERT INTO plans (name) VALUES ('legacy plan');
  `);
}

describe('migration 0060 plan anchor weekday', () => {
  it('adds a nullable column and keeps existing rows NULL', () => {
    const mem = makeMigrationDb();
    createPre0060Schema(mem);
    runMigration(mem, MIGRATION);

    expect(mem.public.one(`SELECT anchor_weekday FROM plans;`)).toEqual({
      anchor_weekday: null,
    });
  });

  it('accepts 1-7 and rejects out-of-range values via CHECK', () => {
    const mem = makeMigrationDb();
    createPre0060Schema(mem);
    runMigration(mem, MIGRATION);

    mem.public.none(`UPDATE plans SET anchor_weekday = 1;`);
    mem.public.none(`UPDATE plans SET anchor_weekday = 7;`);
    expect(() => {
      mem.public.none(`UPDATE plans SET anchor_weekday = 0;`);
    }).toThrow();
    expect(() => {
      mem.public.none(`UPDATE plans SET anchor_weekday = 8;`);
    }).toThrow();
  });
});
