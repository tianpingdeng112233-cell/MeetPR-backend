import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0063-pct-anchor.sql';

function createPre0063Schema(
  mem: ReturnType<typeof makeMigrationDb>,
  withExistingRow: boolean,
): void {
  mem.public.none(`
    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      load_mode TEXT
    );
  `);
  if (withExistingRow) {
    mem.public.none(`INSERT INTO plan_sets (load_mode) VALUES ('rpe');`);
  }
}

describe('migration 0063 pct anchor', () => {
  it('applies to a clean database and accepts all pct anchors', () => {
    const mem = makeMigrationDb();
    createPre0063Schema(mem, false);
    runMigration(mem, MIGRATION);

    mem.public.none(`
      INSERT INTO plan_sets (load_mode, pct_anchor) VALUES
        ('pct', 'one_rm'),
        ('pct', 'e1rm'),
        ('pct', 'top_set');
    `);
    expect(mem.public.many(`SELECT pct_anchor FROM plan_sets ORDER BY pct_anchor;`)).toEqual([
      { pct_anchor: 'e1rm' },
      { pct_anchor: 'one_rm' },
      { pct_anchor: 'top_set' },
    ]);
  });

  it('preserves existing rows as null and enforces pct-only anchor semantics', () => {
    const mem = makeMigrationDb();
    createPre0063Schema(mem, true);
    runMigration(mem, MIGRATION);

    expect(mem.public.one(`SELECT load_mode, pct_anchor FROM plan_sets;`)).toEqual({
      load_mode: 'rpe',
      pct_anchor: null,
    });
    expect(() => {
      mem.public.none(`UPDATE plan_sets SET pct_anchor = 'one_rm';`);
    }).toThrow();
    expect(() => {
      mem.public.none(`INSERT INTO plan_sets (load_mode, pct_anchor) VALUES ('pct', 'tm');`);
    }).toThrow();
    // Three-valued logic hole: load_mode NULL must not slip past the CHECK.
    expect(() => {
      mem.public.none(`INSERT INTO plan_sets (load_mode, pct_anchor) VALUES (NULL, 'one_rm');`);
    }).toThrow();
  });
});
