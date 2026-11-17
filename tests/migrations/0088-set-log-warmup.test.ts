import { describe, expect, it } from 'vitest';
import { makeMigrationDb, runMigration } from '../helpers/migrations';

const migration = 'db/migrations/0088-set-log-warmup.sql';

describe('migration 0088 warm-up sets', () => {
  it('preserves existing rows, defaults old writes to false and constrains warm-up ownership', () => {
    for (const existing of [false, true]) {
      const mem = makeMigrationDb();
      mem.public.none(`CREATE TABLE set_logs (
        id integer PRIMARY KEY, plan_exercise_id uuid, adhoc boolean NOT NULL DEFAULT false
      )`);
      if (existing) mem.public.none('INSERT INTO set_logs (id) VALUES (1)');
      const before = mem.public.many('SELECT * FROM set_logs') as {
        id: number;
        plan_exercise_id: string | null;
        adhoc: boolean;
      }[];
      runMigration(mem, migration);
      expect(mem.public.many('SELECT * FROM set_logs')).toEqual(
        before.map((row) => ({ ...row, is_warmup: false })),
      );
      mem.public.none('INSERT INTO set_logs (id) VALUES (2)');
      expect(mem.public.one('SELECT is_warmup FROM set_logs WHERE id = 2')).toEqual({
        is_warmup: false,
      });
      for (const [id, plan, adhoc] of [
        [3, 'NULL', false],
        [4, 'NULL', true],
        [5, "'10000000-0000-4000-8000-000000000001'", true],
      ] as const) {
        expect(() => {
          mem.public.none(
            `INSERT INTO set_logs VALUES (${String(id)}, ${plan}, ${String(adhoc)}, true)`,
          );
        }).toThrow();
      }
      expect(() => {
        mem.public.none('INSERT INTO set_logs (id, is_warmup) VALUES (6, NULL)');
      }).toThrow();
      mem.public.none(
        `INSERT INTO set_logs VALUES (7, '10000000-0000-4000-8000-000000000001', false, true)`,
      );
      expect(mem.public.one('SELECT is_warmup FROM set_logs WHERE id = 7')).toEqual({
        is_warmup: true,
      });
    }
  });
});
