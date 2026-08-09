import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0058-intensity-system.sql';

function createPre0058Schema(mem: ReturnType<typeof makeMigrationDb>): void {
  mem.public.none(`
    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      intensity_mode TEXT NOT NULL,
      target_value NUMERIC(6,2) NOT NULL,
      rpe_low SMALLINT,
      rpe_high SMALLINT,
      rir_target SMALLINT,
      load_mode TEXT
    );

    INSERT INTO plan_sets (intensity_mode, target_value, rpe_low, rpe_high)
    VALUES ('rpe', 7.00, 7, 8);
  `);
}

describe('migration 0058 intensity system', () => {
  it('widens RPE bounds and preserves existing rows with nullable new columns', () => {
    const mem = makeMigrationDb();
    createPre0058Schema(mem);
    runMigration(mem, MIGRATION);

    expect(
      mem.public.one(`
        SELECT rpe_low, rpe_high, load_mode, target_pct, target_rpe,
               weight_low, weight_high, target_weight
        FROM plan_sets;
      `),
    ).toEqual({
      rpe_low: 7,
      rpe_high: 8,
      load_mode: null,
      target_pct: null,
      target_rpe: null,
      weight_low: null,
      weight_high: null,
      target_weight: null,
    });

    mem.public.none(`
      UPDATE plan_sets
      SET load_mode = 'rpe_range', rpe_low = 7.5, rpe_high = 8.5;
    `);
    expect(mem.public.one(`SELECT rpe_low, rpe_high FROM plan_sets;`)).toEqual({
      rpe_low: 7.5,
      rpe_high: 8.5,
    });
  });

  it('enforces load modes and database value-domain guardrails', () => {
    const mem = makeMigrationDb();
    createPre0058Schema(mem);
    runMigration(mem, MIGRATION);

    expect(() => {
      mem.public.none(`UPDATE plan_sets SET load_mode = 'velocity';`);
    }).toThrow();
    expect(() => {
      mem.public.none(`UPDATE plan_sets SET target_pct = 111.0;`);
    }).toThrow();
    expect(() => {
      mem.public.none(`UPDATE plan_sets SET weight_low = 200, weight_high = 100;`);
    }).toThrow();
    expect(() => {
      mem.public.none(`UPDATE plan_sets SET target_weight = 1000;`);
    }).toThrow();
  });
});
