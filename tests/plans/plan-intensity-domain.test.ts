import { describe, expect, it } from 'vitest';

import {
  intensityState,
  intensityWrite,
  mergedIntensityState,
  validateIntensityState,
} from '../../src/routes/plans/intensity';

describe('plan intensity domain', () => {
  it.each([
    ['59.5', '5.00'],
    ['60.0', '6.00'],
    ['70.0', '7.00'],
    ['80.0', '8.00'],
    ['87.5', '9.00'],
    ['93.0', '10.00'],
  ])('projects pct %s to legacy RPE %s', (targetPct, targetValue) => {
    expect(
      intensityWrite(intensityState({ load_mode: 'pct', target_pct: targetPct })),
    ).toMatchObject({ intensity_mode: 'rpe', target_value: targetValue });
  });

  it('projects each non-pct mode and gives target_weight precedence', () => {
    expect(intensityWrite(intensityState({ load_mode: 'rpe', target_rpe: '8.5' }))).toMatchObject({
      intensity_mode: 'rpe',
      target_value: '8.50',
    });
    expect(intensityWrite(intensityState({ load_mode: 'rir', rir_target: '2' }))).toMatchObject({
      intensity_mode: 'rpe',
      target_value: '8.00',
    });
    expect(
      intensityWrite(intensityState({ load_mode: 'rpe_range', rpe_low: '7.0', rpe_high: '8.0' })),
    ).toMatchObject({ intensity_mode: 'rpe', target_value: '7.00' });
    expect(
      intensityWrite(
        intensityState({ load_mode: 'weight_range', weight_low: '165', weight_high: '175' }),
      ),
    ).toMatchObject({ intensity_mode: 'weight', target_value: '165.00' });
    expect(
      intensityWrite(intensityState({ load_mode: 'rir', rir_target: '2', target_weight: '170' })),
    ).toMatchObject({ intensity_mode: 'weight', target_value: '170.00' });
  });

  it('merges patches, coalesces legacy weight, and clears stale values on mode switches', () => {
    const legacyWeight = {
      load_mode: null,
      intensity_mode: 'weight',
      target_value: '170.00',
      target_pct: null,
      target_rpe: null,
      rir_target: null,
      rpe_low: null,
      rpe_high: null,
      weight_low: null,
      weight_high: null,
      target_weight: null,
    } as Parameters<typeof mergedIntensityState>[0];
    expect(mergedIntensityState(legacyWeight, { load_mode: null })).toMatchObject({
      load_mode: null,
      target_weight: '170.00',
    });

    const rpeWithWeight = {
      ...legacyWeight,
      load_mode: 'rpe',
      target_rpe: '8.0',
      target_weight: '170.00',
    } as Parameters<typeof mergedIntensityState>[0];
    expect(
      mergedIntensityState(rpeWithWeight, {
        load_mode: 'weight_range',
        weight_low: '165',
        weight_high: '175',
      }),
    ).toEqual({
      load_mode: 'weight_range',
      target_pct: null,
      target_rpe: null,
      rir_target: null,
      rpe_low: null,
      rpe_high: null,
      weight_low: '165',
      weight_high: '175',
      target_weight: null,
    });
  });

  it.each([
    [{ load_mode: 'pct' as const }, 'target_pct'],
    [{ load_mode: 'rpe' as const, target_rpe: '8', rir_target: '2' }, 'rir_target'],
    [{ load_mode: 'fixed_weight' as const }, 'target_weight'],
    [
      {
        load_mode: 'weight_range' as const,
        weight_low: '100',
        weight_high: '110',
        target_weight: '105',
      },
      'target_weight',
    ],
    [{ load_mode: null }, 'target_weight'],
  ])('rejects invalid matrix state %#', (input, path) => {
    expect(validateIntensityState(intensityState(input))).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: [path] })]),
    );
  });

  it.each([
    [{ load_mode: 'pct' as const, target_pct: '19.9' }, 'target_pct'],
    [{ load_mode: 'pct' as const, target_pct: '110.5' }, 'target_pct'],
    [{ load_mode: 'pct' as const, target_pct: '72.3' }, 'target_pct'],
    [{ load_mode: 'rpe' as const, target_rpe: '0.4' }, 'target_rpe'],
    [{ load_mode: 'rpe' as const, target_rpe: '10.5' }, 'target_rpe'],
    [{ load_mode: 'rir' as const, rir_target: '-1' }, 'rir_target'],
    [{ load_mode: 'rir' as const, rir_target: '10' }, 'rir_target'],
    [{ load_mode: 'rpe_range' as const, rpe_low: '8', rpe_high: '8' }, 'rpe_high'],
    [{ load_mode: 'weight_range' as const, weight_low: '120', weight_high: '110' }, 'weight_high'],
  ])('rejects invalid value state %#', (input, path) => {
    expect(validateIntensityState(intensityState(input))).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: [path] })]),
    );
  });
});
