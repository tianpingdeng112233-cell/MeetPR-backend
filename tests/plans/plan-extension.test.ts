import { describe, expect, it } from 'vitest';

import { isPurePlanExtension } from '../../src/routes/plans/plan-extension';

describe('isPurePlanExtension', () => {
  const current = { start_date: '2026-05-01', end_date: '2026-05-28', plan_weeks: 4 };

  it('allows extending both weeks and end date without moving the start', () => {
    expect(isPurePlanExtension(current, { plan_weeks: 6, end_date: '2026-06-11' })).toBe(true);
  });

  it.each([
    ['equal values', { ...current }, true],
    ['one more week only', { plan_weeks: 5 }, true],
    ['one more day only', { end_date: '2026-05-29' }, true],
    ['unchanged start date', { start_date: '2026-05-01', plan_weeks: 5 }, true],
    ['maximum weeks', { plan_weeks: 52 }, true],
    ['over maximum weeks', { plan_weeks: 53 }, false],
    ['fewer weeks with later end', { plan_weeks: 3, end_date: '2026-06-11' }, false],
    ['earlier end with more weeks', { plan_weeks: 6, end_date: '2026-05-27' }, false],
    ['earlier start', { start_date: '2026-04-30' }, false],
    ['later start', { start_date: '2026-05-02' }, false],
    ['end before start', { end_date: '2026-04-30' }, false],
  ])('%s', (_label, patch, expected) => {
    expect(isPurePlanExtension(current, patch)).toBe(expected);
  });

  it('compares pg-mem DATE values with the same date-only semantics', () => {
    expect(
      isPurePlanExtension(
        { ...current, start_date: new Date('2026-05-01'), end_date: new Date('2026-05-28') },
        { start_date: '2026-05-01', end_date: '2026-05-28', plan_weeks: 4 },
      ),
    ).toBe(true);
  });

  it('requires merged date order even when the patch only contains weeks', () => {
    expect(isPurePlanExtension({ ...current, end_date: '2026-04-30' }, { plan_weeks: 5 })).toBe(
      false,
    );
  });
});
