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
  it('keeps the legacy intensity shape and accepts new-system creates without projection fields', () => {
    expect(CreatePlanSetBodySchema.safeParse(baseSet).success).toBe(true);
    expect(
      CreatePlanSetBodySchema.safeParse({
        ...baseSet,
        intensity_mode: undefined,
        target_value: undefined,
        load_mode: 'rpe',
        target_rpe: 8.5,
      }).success,
    ).toBe(true);
    expect(
      CreatePlanSetBodySchema.safeParse({
        ...baseSet,
        intensity_mode: undefined,
        target_value: undefined,
        load_mode: null,
        target_weight: 180,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ target_weight: 180 }, ['load_mode']],
    [{ load_mode: 'pct', target_pct: 72.3 }, ['target_pct']],
    [{ load_mode: 'rpe', target_rpe: 8, rir_target: 2 }, ['rir_target']],
    [{ load_mode: 'fixed_weight' }, ['target_weight']],
    [
      { load_mode: 'weight_range', weight_low: 100, weight_high: 110, target_weight: 105 },
      ['target_weight'],
    ],
  ])('rejects invalid new-system create %#', (intensity, path) => {
    const result = CreatePlanSetBodySchema.safeParse({
      ...baseSet,
      intensity_mode: undefined,
      target_value: undefined,
      ...intensity,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
    }
  });

  it('accepts a partial new-system patch for final-state validation after the row is loaded', () => {
    expect(PatchPlanSetBodySchema.safeParse({ target_rpe: 8.5 }).success).toBe(true);
  });

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
