import fs from 'node:fs';
import { DataType } from 'pg-mem';
import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0080-load-types.sql';

interface StoredSet {
  id: string;
  plan_exercise_id: string;
  coach_note: string | null;
  load_mode: string | null;
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
    INSERT INTO plan_sets (coach_note, load_mode, intensity_mode, target_value) VALUES
      ('自重', NULL, 'rpe', 10),
      ('自重 慢下放', NULL, 'rpe', 10),
      ('BODYWEIGHT', NULL, 'rpe', 10),
      ('自重  自重热身后加重  ', NULL, 'rpe', 10),
      ('自重热身后加重', NULL, 'weight', 135),
      ('自重', NULL, 'rpe', 8),
      ('正常备注', NULL, 'weight', 100),
      (NULL, NULL, 'rpe', 7),
      ('自重', 'rpe', 'rpe', 8);
    INSERT INTO plan_sets (plan_exercise_id, coach_note, intensity_mode, target_value) VALUES
      ('90000000-0000-4000-8000-000000000001', '自重', 'rpe', 10),
      ('90000000-0000-4000-8000-000000000001', NULL, 'rpe', 10);
  `);
  return mem;
}

describe('migration 0080 load types', () => {
  it('backfills only legacy markers, saves originals, and restores every field on rollback', () => {
    const mem = beforeMigration();
    const original = mem.public.many('SELECT * FROM plan_sets ORDER BY id') as StoredSet[];
    runMigration(mem, MIGRATION);
    const migrated = mem.public.many('SELECT * FROM plan_sets ORDER BY id') as StoredSet[];
    const backup = mem.public.many('SELECT * FROM plan_sets_load_types_0080_backup ORDER BY id');
    expect(backup).toHaveLength(4);
    expect(backup).toEqual(
      original
        .filter(
          (row) =>
            row.load_mode === null &&
            row.intensity_mode === 'rpe' &&
            row.target_value === 10 &&
            row.plan_exercise_id !== '90000000-0000-4000-8000-000000000001',
        )
        .map(({ id, coach_note, load_mode }) => ({ id, coach_note, load_mode })),
    );
    for (const row of migrated) {
      const old = original.find((item) => item.id === row.id);
      if (!old) throw new Error('missing original row');
      expect(row.intensity_mode).toBe(old.intensity_mode);
      expect(row.target_value).toBe(old.target_value);
      if (backup.some((item) => item.id === row.id)) {
        expect(row.load_mode).toBe('bodyweight');
      } else {
        expect(row).toEqual(old);
      }
    }
    expect(
      migrated.filter((row) => row.load_mode === 'bodyweight').map((row) => row.coach_note),
    ).toEqual(expect.arrayContaining([null, null, ' 慢下放', '  自重热身后加重  ']));

    const rollback = fs.readFileSync(MIGRATION, 'utf8').split('/* ROLLBACK\n')[1]?.split('*/')[0];
    expect(rollback).toBeTruthy();
    if (!rollback) throw new Error('missing rollback SQL');
    mem.public.none(rollback);
    expect(mem.public.many('SELECT * FROM plan_sets ORDER BY id')).toEqual(original);
    expect(() => {
      mem.public.none("INSERT INTO plan_sets (load_mode) VALUES ('bodyweight')");
    }).toThrow();
  });

  it('allows absent legacy targets only for the two new load modes and keeps old checks', () => {
    const mem = beforeMigration();
    runMigration(mem, MIGRATION);
    for (const mode of ['bodyweight', 'free_weight']) {
      expect(() => {
        mem.public.none(`INSERT INTO plan_sets (load_mode) VALUES ('${mode}')`);
      }).not.toThrow();
    }
    for (const mode of [null, 'rpe', 'fixed_weight', 'unknown']) {
      expect(() => {
        mem.public.none(
          `INSERT INTO plan_sets (load_mode) VALUES (${mode === null ? 'NULL' : `'${mode}'`})`,
        );
      }).toThrow();
    }
    for (const [mode, value] of [
      ['rpe', 11],
      ['weight', 0],
      [null, 10],
      ['rpe', null],
    ] as const) {
      expect(() => {
        mem.public.none(
          `INSERT INTO plan_sets (intensity_mode, target_value) VALUES (${mode === null ? 'NULL' : `'${mode}'`}, ${String(value ?? 'NULL')})`,
        );
      }).toThrow();
    }
    expect(() => {
      mem.public.none(
        "INSERT INTO plan_sets (load_mode, intensity_mode, target_value) VALUES ('bodyweight', 'rpe', 11)",
      );
    }).toThrow();
  });
});

describe('D1 migration data safety', () => {
  it.each([
    ['weight mention', 'weight', 135, '自重热身后加重'],
    ['RPE 8 marker', 'rpe', 8, '自重'],
    ['free-text RPE 10 mention', 'rpe', 10, '自重热身后加重'],
  ])('preserves %s verbatim', (_name, mode, value, note) => {
    const mem = beforeMigration();
    mem.public.none('DELETE FROM plan_sets');
    mem.public.none(
      `INSERT INTO plan_sets (intensity_mode, target_value, coach_note) VALUES ('${mode}', ${String(value)}, '${note}')`,
    );
    const before = mem.public.many('SELECT * FROM plan_sets');
    runMigration(mem, MIGRATION);
    expect(mem.public.many('SELECT * FROM plan_sets')).toEqual(before);
    expect(mem.public.many('SELECT * FROM plan_sets_load_types_0080_backup')).toEqual([]);
  });

  it('converts all qualifying sets together and preserves every other note byte', () => {
    const mem = beforeMigration();
    mem.public.none('DELETE FROM plan_sets');
    mem.public
      .none(`INSERT INTO plan_sets (plan_exercise_id, intensity_mode, target_value, coach_note) VALUES
      ('90000000-0000-4000-8000-000000000001', 'rpe', 10, '自重'),
      ('90000000-0000-4000-8000-000000000001', 'rpe', 10, 'BODYWEIGHT  自重热身后加重  ')`);
    runMigration(mem, MIGRATION);
    expect(mem.public.many('SELECT load_mode, coach_note FROM plan_sets')).toEqual([
      { load_mode: 'bodyweight', coach_note: null },
      { load_mode: 'bodyweight', coach_note: '  自重热身后加重  ' },
    ]);
    expect(mem.public.many('SELECT * FROM plan_sets_load_types_0080_backup')).toHaveLength(2);
  });

  it.each([null, '自重热身后加重'])('leaves a mixed row untouched when one note is %s', (note) => {
    const mem = beforeMigration();
    mem.public.none('DELETE FROM plan_sets');
    mem.public
      .none(`INSERT INTO plan_sets (plan_exercise_id, intensity_mode, target_value, coach_note) VALUES
      ('90000000-0000-4000-8000-000000000001', 'rpe', 10, '自重'),
      ('90000000-0000-4000-8000-000000000001', 'rpe', 10, ${note === null ? 'NULL' : `'${note}'`})`);
    const before = mem.public.many('SELECT * FROM plan_sets');
    runMigration(mem, MIGRATION);
    expect(mem.public.many('SELECT * FROM plan_sets')).toEqual(before);
    expect(mem.public.many('SELECT * FROM plan_sets_load_types_0080_backup')).toEqual([]);
  });
});
