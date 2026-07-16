import { describe, expect, it } from 'vitest';

import {
  effectiveDateBeforeBatch,
  effectivePlanDays,
  latestShiftBatch,
  plannedDate,
} from '../../src/domain/plan-calendar';

const day = { id: 'day-1', week_number: 2, day_of_week: 3 };

describe('plan calendar', () => {
  it('projects plan days positionally from start_date', () => {
    expect(plannedDate('2026-07-15', 1, 1)).toBe('2026-07-15');
    expect(plannedDate('2026-07-15', 2, 3)).toBe('2026-07-24');
  });

  it('uses the latest shift by created_at and id even when rows are unordered', () => {
    const shifts = [
      {
        id: 'shift-b',
        plan_day_id: day.id,
        batch_id: 'batch-2',
        shifted_to_date: '2026-07-26',
        created_at: new Date('2026-07-16T00:00:00Z'),
      },
      {
        id: 'shift-a',
        plan_day_id: day.id,
        batch_id: 'batch-1',
        shifted_to_date: '2026-07-25',
        created_at: new Date('2026-07-15T00:00:00Z'),
      },
    ];

    expect(effectivePlanDays({ start_date: '2026-07-15' }, [day], shifts)).toEqual([
      { day, effectiveDate: '2026-07-26' },
    ]);
    expect(latestShiftBatch(shifts)).toEqual([shifts[0]]);
    expect(effectiveDateBeforeBatch({ start_date: '2026-07-15' }, day, shifts, 'batch-2')).toBe(
      '2026-07-25',
    );
  });

  it('breaks a created_at tie by the larger id', () => {
    const tiedAt = new Date('2026-07-16T00:00:00Z');
    const shifts = [
      {
        id: 'shift-z',
        plan_day_id: day.id,
        batch_id: 'batch-z',
        shifted_to_date: '2026-07-27',
        created_at: tiedAt,
      },
      {
        id: 'shift-a',
        plan_day_id: day.id,
        batch_id: 'batch-a',
        shifted_to_date: '2026-07-26',
        created_at: tiedAt,
      },
    ];

    expect(effectivePlanDays({ start_date: '2026-07-15' }, [day], shifts)).toEqual([
      { day, effectiveDate: '2026-07-27' },
    ]);
    expect(latestShiftBatch(shifts)).toEqual([shifts[0]]);
  });

  it('falls back to the planned date before the first shift batch', () => {
    const shift = {
      id: 'shift-a',
      plan_day_id: day.id,
      batch_id: 'batch-1',
      shifted_to_date: '2026-07-25',
      created_at: new Date('2026-07-15T00:00:00Z'),
    };
    expect(effectiveDateBeforeBatch({ start_date: '2026-07-15' }, day, [shift], 'batch-1')).toBe(
      '2026-07-24',
    );
  });
});
