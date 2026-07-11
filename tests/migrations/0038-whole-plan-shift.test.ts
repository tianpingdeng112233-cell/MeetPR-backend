import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';

describe('migration 0038 whole plan shift batches', () => {
  it('backfills independent batches and permits append-only day history', () => {
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
      CREATE TABLE plan_day_shifts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES users(id),
        shifted_to_date DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT plan_day_shifts_plan_day_id_key UNIQUE (plan_day_id)
      );
    `);

    const studentId = randomUUID();
    const firstDayId = randomUUID();
    const secondDayId = randomUUID();
    mem.public.none(`
      INSERT INTO users (id) VALUES ('${studentId}');
      INSERT INTO plan_days (id) VALUES ('${firstDayId}'), ('${secondDayId}');
      INSERT INTO plan_day_shifts (plan_day_id, student_id, shifted_to_date) VALUES
        ('${firstDayId}', '${studentId}', DATE '2026-07-11'),
        ('${secondDayId}', '${studentId}', DATE '2026-07-12');
    `);

    mem.public.none(fs.readFileSync('db/migrations/0038-whole-plan-shift.sql', 'utf8'));

    const backfilled = mem.public.many(
      `SELECT batch_id, created_at FROM plan_day_shifts ORDER BY plan_day_id`,
    ) as { batch_id: string; created_at: Date }[];
    expect(backfilled).toHaveLength(2);
    expect(backfilled[0]?.batch_id).toEqual(expect.any(String));
    expect(backfilled[1]?.batch_id).toEqual(expect.any(String));
    expect(backfilled[0]?.batch_id).not.toBe(backfilled[1]?.batch_id);
    expect(backfilled.every((row) => row.created_at instanceof Date)).toBe(true);

    const nextBatchId = randomUUID();
    mem.public.none(`
      INSERT INTO plan_day_shifts (plan_day_id, student_id, batch_id, shifted_to_date)
      VALUES ('${firstDayId}', '${studentId}', '${nextBatchId}', DATE '2026-07-12');
    `);
    expect(
      mem.public.many(`SELECT id FROM plan_day_shifts WHERE plan_day_id = '${firstDayId}'`),
    ).toHaveLength(2);

    expect(() => {
      mem.public.none(`
        INSERT INTO plan_day_shifts (plan_day_id, student_id, batch_id, shifted_to_date)
        VALUES ('${firstDayId}', '${studentId}', '${nextBatchId}', DATE '2026-07-13');
      `);
    }).toThrow(/duplicate key|unique/i);
  });
});
