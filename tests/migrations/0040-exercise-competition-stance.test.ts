import { randomUUID } from 'node:crypto';

import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';

import { runMigration } from '../helpers/migrations';

describe('migration 0040 exercise competition stance', () => {
  it('adds the constrained nullable column and tags only the four stance-specific lifts', () => {
    const mem = newDb();
    mem.public.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      impure: true,
      implementation: randomUUID,
    });
    mem.public.none(`
      CREATE TABLE exercises (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL
      );
      INSERT INTO exercises (id, name) VALUES
        ('00000000-0000-0000-ca71-000000000001', '低杠位深蹲'),
        ('00000000-0000-0000-ca70-000000000016', '高杠位深蹲'),
        ('4a912d5c-2248-4f3d-80ec-384f8360c315', '传统硬拉'),
        ('faa76bdb-844a-42a2-8298-ed073e9915c1', '相扑硬拉'),
        ('2f708759-821a-4d5b-9fde-32f60bc2b7f2', '竞技深蹲'),
        ('40c56af8-69d8-4a4a-a690-526ee38d081b', '竞技卧推'),
        ('00000000-0000-0000-ca70-000000000019', '暂停深蹲');
    `);

    runMigration(mem, 'db/migrations/0040-exercise-competition-stance.sql');

    expect(mem.public.many(`SELECT name, competition_stance FROM exercises ORDER BY name`)).toEqual(
      [
        { name: '传统硬拉', competition_stance: 'conventional' },
        { name: '低杠位深蹲', competition_stance: 'low_bar' },
        { name: '暂停深蹲', competition_stance: null },
        { name: '相扑硬拉', competition_stance: 'sumo' },
        { name: '竞技卧推', competition_stance: null },
        { name: '竞技深蹲', competition_stance: null },
        { name: '高杠位深蹲', competition_stance: 'high_bar' },
      ],
    );
    expect(() => {
      mem.public.none(`UPDATE exercises SET competition_stance = 'wide' WHERE name = '竞技深蹲'`);
    }).toThrow(/check constraint/i);
  });
});
