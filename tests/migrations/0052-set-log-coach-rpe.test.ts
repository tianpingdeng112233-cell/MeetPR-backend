import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

function setup() {
  const mem = makeMigrationDb();
  mem.public.none(`
    CREATE TABLE set_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rpe NUMERIC(3,1)
    );
    INSERT INTO set_logs (rpe) VALUES (6.0);
  `);
  runMigration(mem, 'db/migrations/0052-add-set-log-coach-rpe.sql');
  return mem;
}

describe('migration 0052 set-log coach RPE', () => {
  it('keeps existing rows null and accepts inclusive bounds', () => {
    const mem = setup();

    expect(mem.public.one(`SELECT rpe, coach_rpe FROM set_logs;`)).toEqual({
      rpe: 6,
      coach_rpe: null,
    });

    mem.public.none(`
      INSERT INTO set_logs (coach_rpe) VALUES (0), (8.5), (10);
    `);
    expect(mem.public.many(`SELECT coach_rpe FROM set_logs WHERE coach_rpe IS NOT NULL;`)).toEqual([
      { coach_rpe: 0 },
      { coach_rpe: 8.5 },
      { coach_rpe: 10 },
    ]);
  });

  it('rejects values outside 0...10 and remains additive-only', () => {
    const mem = setup();
    expect(() => {
      mem.public.none(`INSERT INTO set_logs (coach_rpe) VALUES (-0.5);`);
    }).toThrow(/check constraint|violates/i);
    expect(() => {
      mem.public.none(`INSERT INTO set_logs (coach_rpe) VALUES (10.5);`);
    }).toThrow(/check constraint|violates/i);

    const sql = fs.readFileSync('db/migrations/0052-add-set-log-coach-rpe.sql', 'utf8');
    expect(sql).toMatch(/ALTER TABLE set_logs\s+ADD COLUMN coach_rpe NUMERIC\(3,1\) NULL/);
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\b/);
  });
});
