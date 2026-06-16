import { describe, expect, it } from 'vitest';

import { CreatePlanSetBodySchema, PatchPlanSetBodySchema } from '../../src/routes/plans/schemas';

const baseSet = {
  set_number: 1,
  target_reps: 5,
  target_reps_max: null,
  intensity_mode: 'weight' as const,
  target_value: '180.5',
  set_type: 'working' as const,
};

describe('plan set schemas', () => {
  it('accepts omitted, numeric, and null rest_seconds values', () => {
    expect(CreatePlanSetBodySchema.parse(baseSet).rest_seconds).toBeUndefined();
    expect(CreatePlanSetBodySchema.parse({ ...baseSet, rest_seconds: 120 }).rest_seconds).toBe(120);
    expect(
      CreatePlanSetBodySchema.parse({ ...baseSet, rest_seconds: null }).rest_seconds,
    ).toBeNull();
    expect(PatchPlanSetBodySchema.parse({ rest_seconds: null }).rest_seconds).toBeNull();
  });

  it.each([-1, 3601, 1.5])('rejects invalid rest_seconds: %s', (restSeconds) => {
    expect(
      CreatePlanSetBodySchema.safeParse({ ...baseSet, rest_seconds: restSeconds }).success,
    ).toBe(false);
  });
});
