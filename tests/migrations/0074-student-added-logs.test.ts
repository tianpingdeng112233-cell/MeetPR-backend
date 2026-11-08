import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const migration = 'db/migrations/0074-student-added-logs.sql';

describe('migration 0074 student-added logs', () => {
  it('applies to empty and existing tables, is reentrant, and detaches deleted days', () => {
    for (const withExisting of [false, true]) {
      const mem = makeMigrationDb({ noAstCoverageCheck: true });
      mem.public.none(`
        CREATE TABLE plan_days (id UUID PRIMARY KEY);
        CREATE TABLE set_logs (id INTEGER PRIMARY KEY, adhoc BOOLEAN NOT NULL DEFAULT false);
        INSERT INTO plan_days VALUES ('10000000-0000-4000-8000-000000000001');
      `);
      if (withExisting) mem.public.none('INSERT INTO set_logs (id) VALUES (1)');
      runMigration(mem, migration);
      runMigration(mem, migration);
      if (withExisting) {
        expect(mem.public.one('SELECT plan_day_id FROM set_logs WHERE id = 1')).toEqual({
          plan_day_id: null,
        });
      }
      mem.public.none(`INSERT INTO set_logs (id, adhoc, plan_day_id)
        VALUES (2, true, '10000000-0000-4000-8000-000000000001')`);
      expect(() => {
        mem.public.none(`INSERT INTO set_logs (id, adhoc, plan_day_id)
        VALUES (3, false, '10000000-0000-4000-8000-000000000001')`);
      }).toThrow();
      expect(() => {
        mem.public.none(`INSERT INTO set_logs (id, adhoc, plan_day_id)
        VALUES (4, true, '10000000-0000-4000-8000-000000000002')`);
      }).toThrow();
      mem.public.none('DELETE FROM plan_days');
      expect(mem.public.one('SELECT adhoc, plan_day_id FROM set_logs WHERE id = 2')).toEqual({
        adhoc: true,
        plan_day_id: null,
      });
      expect(mem.public.getTable('set_logs').listIndices()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'set_logs_plan_day_idx', unique: false }),
        ]),
      );
    }
  });
});
