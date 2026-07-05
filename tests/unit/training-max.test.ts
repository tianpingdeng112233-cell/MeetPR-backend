import { describe, expect, it } from 'vitest';

import {
  calculateTrainingMaxKg,
  formatTrainingMaxKg,
  isTrainingMaxFresh,
} from '../../src/services/trainingMax';

describe('training max helpers', () => {
  it('ceil-rounds 90% of true 1RM to the next 2.5kg increment', () => {
    expect(calculateTrainingMaxKg(100)).toBe(90);
    expect(calculateTrainingMaxKg(102.5)).toBe(92.5);
    expect(formatTrainingMaxKg(calculateTrainingMaxKg(102.5))).toBe('92.50');
  });

  it('treats TM as fresh through 42 days and expired after that boundary', () => {
    const setAt = new Date('2026-07-01T00:00:00.000Z');

    expect(isTrainingMaxFresh(setAt, new Date('2026-08-12T00:00:00.000Z'))).toBe(true);
    expect(isTrainingMaxFresh(setAt, new Date('2026-08-12T00:00:00.001Z'))).toBe(false);
    expect(isTrainingMaxFresh(null, new Date('2026-08-01T00:00:00.000Z'))).toBe(false);
  });

  it('rejects invalid 1RM input', () => {
    expect(() => calculateTrainingMaxKg(0)).toThrow(RangeError);
    expect(() => calculateTrainingMaxKg(Number.NaN)).toThrow(RangeError);
  });
});
