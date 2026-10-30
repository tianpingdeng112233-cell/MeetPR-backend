import fs from 'node:fs';
import { DataType } from 'pg-mem';
import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0081-rpe-mode-bodyweight.sql';

interface StoredSet {
  id: string;
  plan_exercise_id: string;
  coach_note: string | null;
  load_mode: string | null;
  target_rpe: number | null;
  intensity_mode: string | null;
  target_value: number | null;
}

function beforeMigration() {
  const mem = makeMigrationDb();
  mem.public.registerFunction({
    name: 'nullif',
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string, other: string) => (value === other ? null : value),
  });
  // pg-mem lacks PostgreSQL regexp_replace; emulate this SQL boundary only.
  mem.public.registerFunction({
    name: 'regexp_replace',
    args: [DataType.text, DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string, pattern: string, replacement: string, flags: string) =>
      value.replace(new RegExp(pattern, flags), replacement.replace(/\\([1-9])/g, '$$$1')),
  });
  mem.public.none(`
    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_exercise_id UUID NOT NULL DEFAULT gen_random_uuid(),
      coach_note TEXT,
      load_mode TEXT,
      target_rpe NUMERIC(3,1),
      intensity_mode TEXT NOT NULL,
      target_value NUMERIC(6,2) NOT NULL,
      CONSTRAINT plan_sets_load_mode_check CHECK (
        load_mode IS NULL OR load_mode IN ('pct', 'rpe', 'rir', 'weight_range', 'rpe_range', 'fixed_weight')
      ),
      CONSTRAINT plan_sets_intensity_mode_check CHECK (intensity_mode IN ('weight', 'rpe')),
      CONSTRAINT plan_sets_target_value_check CHECK (
        (intensity_mode = 'rpe' AND target_value BETWEEN 1 AND 10) OR
        (intensity_mode = 'weight' AND target_value > 0 AND target_value < 1000)
      )
    );
  `);
  runMigration(mem, 'db/migrations/0080-load-types.sql');
  return mem;
}

describe('migration 0081 rpe-mode bodyweight', () => {
  it('backs up all matching siblings, clears RPE 10, strips one marker and rolls back exactly', () => {
    const mem = beforeMigration();
    mem.public.none(`
      INSERT INTO plan_sets (plan_exercise_id, coach_note, load_mode, target_rpe, intensity_mode, target_value) VALUES
        ('90000000-0000-4000-8000-000000000001', '自重', 'rpe', 10, 'rpe', 10),
        ('90000000-0000-4000-8000-000000000001', '自重 慢下放', 'rpe', 10, 'rpe', 10),
        ('90000000-0000-4000-8000-000000000001', 'BODYWEIGHT', 'rpe', 10, 'rpe', 10),
        ('90000000-0000-4000-8000-000000000001', '自重  自重热身后加重  ', 'rpe', 10, 'rpe', 10);
    `);
    const original = mem.public.many('SELECT * FROM plan_sets ORDER BY id') as StoredSet[];
    runMigration(mem, MIGRATION);
    const backup = mem.public.many('SELECT * FROM plan_sets_load_types_0081_backup ORDER BY id');
    expect(backup).toStrictEqual(
      original.map(({ id, coach_note, load_mode, target_rpe }) => ({
        id,
        coach_note,
        load_mode,
        target_rpe,
      })),
    );
    const migrated = mem.public.many('SELECT * FROM plan_sets ORDER BY id') as StoredSet[];
    expect(migrated).toHaveLength(4);
    const expectedNotes: Record<string, string | null> = {
      自重: null,
      '自重 慢下放': ' 慢下放',
      BODYWEIGHT: null,
      '自重  自重热身后加重  ': '  自重热身后加重  ',
    };
    for (const row of migrated) {
      const before = original.find((item) => item.id === row.id);
      if (!before?.coach_note) throw new Error('missing original note');
      expect(row).toStrictEqual({
        ...before,
        load_mode: 'bodyweight',
        target_rpe: null,
        coach_note: expectedNotes[before.coach_note],
      });
    }

    const rollback = fs.readFileSync(MIGRATION, 'utf8').split('/* ROLLBACK\n')[1]?.split('*/')[0];
    if (!rollback) throw new Error('missing rollback SQL');
    mem.public.none(rollback);
    expect(mem.public.many('SELECT * FROM plan_sets ORDER BY id')).toStrictEqual(original);
    expect(mem.public.many('SELECT * FROM plan_sets_load_types_0080_backup')).toEqual([]);
  });

  it.each([
    ['RPE 8 + marker', "'rpe', 8, 'rpe', 8, '自重'"],
    ['weighted + marker', "'fixed_weight', NULL, 'weight', 100, '自重'"],
    ['RPE with weight + marker', "'rpe', 10, 'weight', 100, '自重'"],
    ['missing marker', "'rpe', 10, 'rpe', 10, NULL"],
    ['free-text mention', "'rpe', 10, 'rpe', 10, '自重热身后加重'"],
    ['null load mode', "NULL, 10, 'rpe', 10, '自重'"],
    ['null target RPE', "'rpe', NULL, 'rpe', 10, '自重'"],
    ['different target RPE', "'rpe', 8, 'rpe', 10, '自重'"],
    ['different legacy target', "'rpe', 10, 'rpe', 8, '自重'"],
    ['canonical bodyweight', "'bodyweight', NULL, NULL, NULL, '自重'"],
  ])('preserves the entire exercise when a sibling has %s', (_name, values) => {
    const mem = beforeMigration();
    mem.public.none(`
      INSERT INTO plan_sets (plan_exercise_id, load_mode, target_rpe, intensity_mode, target_value, coach_note) VALUES
        ('90000000-0000-4000-8000-000000000001', 'rpe', 10, 'rpe', 10, '自重'),
        ('90000000-0000-4000-8000-000000000001', ${values});
    `);
    const original = mem.public.many('SELECT * FROM plan_sets ORDER BY id');
    runMigration(mem, MIGRATION);
    expect(mem.public.many('SELECT * FROM plan_sets ORDER BY id')).toStrictEqual(original);
    expect(mem.public.many('SELECT * FROM plan_sets_load_types_0081_backup')).toEqual([]);
  });
});
