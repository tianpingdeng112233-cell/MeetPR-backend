import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';

describe('migration 0037 plan day shifts', () => {
  it('adds one absolute-date shift per plan day with cascading day cleanup', () => {
    const mem = newDb();
    mem.public.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      impure: true,
      implementation: randomUUID,
    });
    mem.public.none(`
      CREATE TABLE users (id UUID PRIMARY KEY);
      CREATE TABLE plan_days (id UUID PRIMARY KEY);
    `);
    mem.public.none(fs.readFileSync('db/migrations/0037-add-plan-day-shifts.sql', 'utf8'));

    const studentId = randomUUID();
    const dayId = randomUUID();
    mem.public.none(`
      INSERT INTO users (id) VALUES ('${studentId}');
      INSERT INTO plan_days (id) VALUES ('${dayId}');
      INSERT INTO plan_day_shifts (plan_day_id, student_id, shifted_to_date)
      VALUES ('${dayId}', '${studentId}', DATE '2026-07-11');
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO plan_day_shifts (plan_day_id, student_id, shifted_to_date)
        VALUES ('${dayId}', '${studentId}', DATE '2026-07-12');
      `);
    }).toThrow(/duplicate key|unique/i);

    mem.public.none(`DELETE FROM plan_days WHERE id = '${dayId}'`);
    expect(mem.public.many(`SELECT * FROM plan_day_shifts`)).toEqual([]);
  });
});
