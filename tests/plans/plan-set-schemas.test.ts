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

  it('accepts omitted, string, and null coach_note values (spec 043)', () => {
    expect(CreatePlanSetBodySchema.parse(baseSet).coach_note).toBeUndefined();
    expect(CreatePlanSetBodySchema.parse({ ...baseSet, coach_note: '70%top' }).coach_note).toBe(
      '70%top',
    );
    expect(CreatePlanSetBodySchema.parse({ ...baseSet, coach_note: null }).coach_note).toBeNull();
    expect(PatchPlanSetBodySchema.parse({ coach_note: '节奏3-1-0' }).coach_note).toBe('节奏3-1-0');
  });

  it('rejects coach_note longer than 500 characters', () => {
    expect(
      CreatePlanSetBodySchema.safeParse({ ...baseSet, coach_note: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});
