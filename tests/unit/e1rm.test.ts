import { describe, expect, it } from 'vitest';

import { MAIN_LIFT_EXERCISE_IDS, calculateEligibleE1RM } from '../../src/domain/e1rm';

const base = {
  exerciseId: MAIN_LIFT_EXERCISE_IDS.squat,
  weightKg: 100,
  reps: 5,
  rpe: null,
  completed: true,
  failed: false,
  confidence: null,
} as const;

describe('e1RM policy', () => {
  it('uses Epley without RPE and the canonical RTS table with eligible RPE', () => {
    expect(calculateEligibleE1RM(base)).toBeCloseTo(116.6667, 4);
    expect(calculateEligibleE1RM({ ...base, rpe: 8 })).toBeCloseTo(128.2051, 4);
  });

  it.each([
    ['incomplete', { completed: false }],
    ['failed', { failed: true }],
    ['RPE below 7', { rpe: 6.5 }],
    ['more than 10 reps', { reps: 11 }],
    ['low confidence', { confidence: 'low' as const }],
    ['non-canonical exercise', { exerciseId: '70000000-0000-4000-8000-000000000001' }],
    ['deadlift above 5 reps', { exerciseId: MAIN_LIFT_EXERCISE_IDS.conventionalDeadlift, reps: 6 }],
  ])('excludes %s points', (_name, override) => {
    expect(calculateEligibleE1RM({ ...base, ...override })).toBeNull();
  });
});
