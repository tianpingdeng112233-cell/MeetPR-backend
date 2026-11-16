import { describe, expect, it } from 'vitest';
import { currentPlanId, type HandoffPlan } from '../../src/domain/plan-handoff';

function plan(id: string, overrides: Partial<HandoffPlan> = {}): HandoffPlan {
  return {
    id,
    start_date: '2026-01-01',
    created_at: '2025-12-01T00:00:00Z',
    published_at: '2025-12-02T00:00:00Z',
    latest_record_at: null,
    days: [{ is_rest: false, completed_at: null }],
    ...overrides,
  };
}

describe('current plan handoff', () => {
  it('keeps the latest recorded unfinished plan regardless of new publication or calendar date', () => {
    expect(
      currentPlanId([
        plan('old', { latest_record_at: '2026-01-05T00:00:00Z' }),
        plan('new', { start_date: '2026-02-01', published_at: '2026-02-02T00:00:00Z' }),
      ]),
    ).toBe('old');
  });
});

it('advances from a completed anchor to the nearest later unfinished plan, skipping an abandoned tail', () => {
  expect(
    currentPlanId([
      plan('abandoned', { start_date: '2025-01-01' }),
      plan('anchor', {
        latest_record_at: '2026-01-05T00:00:00Z',
        days: [{ is_rest: false, completed_at: '2026-01-05T00:00:00Z' }],
      }),
      plan('third', { start_date: '2026-03-01' }),
      plan('next', { start_date: '2026-02-01' }),
    ]),
  ).toBe('next');
});

it('starts with the earliest nonempty unfinished plan when there are no records', () => {
  expect(currentPlanId([plan('later', { start_date: '2026-02-01' }), plan('first')])).toBe('first');
});

it('falls back to latest publication when every training day is settled', () => {
  const days = [{ is_rest: false, completed_at: '2026-02-05T00:00:00Z' }];
  expect(
    currentPlanId([
      plan('old', { days }),
      plan('new', { days, published_at: '2026-02-01T00:00:00Z' }),
    ]),
  ).toBe('new');
});

it('uses created_at and id for stable sequence, anchor and publication ties', () => {
  expect(currentPlanId([plan('b'), plan('a')])).toBe('a');
  expect(currentPlanId([plan('a', { created_at: '2025-12-03T00:00:00Z' }), plan('b')])).toBe('b');
  expect(
    currentPlanId([
      plan('a', { latest_record_at: '2026-01-01T00:00:00Z' }),
      plan('b', { latest_record_at: '2026-01-01T00:00:00Z' }),
    ]),
  ).toBe('b');
  expect(currentPlanId([plan('a', { days: [] }), plan('b', { days: [] })])).toBe('b');
});

it('excludes empty and rest-only plans from handoff but keeps them for the final fallback', () => {
  expect(
    currentPlanId([
      plan('empty', { days: [] }),
      plan('rest', { days: [{ is_rest: true, completed_at: null }] }),
      plan('training', { start_date: '2026-02-01' }),
    ]),
  ).toBe('training');
  expect(currentPlanId([plan('rest', { days: [{ is_rest: true, completed_at: null }] })])).toBe(
    'rest',
  );
  expect(currentPlanId([])).toBeNull();
});

it('returns to the old plan after undo unless the new plan already has a record', () => {
  const old = plan('old', {
    latest_record_at: '2026-01-05T00:00:00Z',
    days: [{ is_rest: false, completed_at: '2026-01-05T00:00:00Z' }],
  });
  const next = plan('next', { start_date: '2026-02-01' });
  expect(currentPlanId([old, next])).toBe('next');
  const undone = { ...old, days: [{ is_rest: false, completed_at: null }] };
  expect(currentPlanId([undone, next])).toBe('old');
  expect(currentPlanId([undone, { ...next, latest_record_at: '2026-02-02T00:00:00Z' }])).toBe(
    'next',
  );
});

it('does not resurrect an abandoned tail if the latest anchor finished and nothing follows', () => {
  expect(
    currentPlanId([
      plan('abandoned'),
      plan('done', {
        start_date: '2026-02-01',
        latest_record_at: '2026-02-02T00:00:00Z',
        published_at: '2026-02-01T00:00:00Z',
        days: [{ is_rest: false, completed_at: '2026-02-02T00:00:00Z' }],
      }),
    ]),
  ).toBe('done');
});
