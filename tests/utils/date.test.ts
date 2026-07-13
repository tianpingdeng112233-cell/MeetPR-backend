import { describe, expect, it } from 'vitest';

import { shanghaiTrainingDay } from '../../src/utils/date';

describe('shanghaiTrainingDay', () => {
  it('keeps a mid-day instant on its own calendar day', () => {
    // 2026-07-13T12:00 Asia/Shanghai
    expect(shanghaiTrainingDay(new Date('2026-07-13T04:00:00Z'))).toBe('2026-07-13');
  });

  it('assigns 03:59 Shanghai to the previous training day', () => {
    // 2026-07-13T03:59 Asia/Shanghai
    expect(shanghaiTrainingDay(new Date('2026-07-12T19:59:00Z'))).toBe('2026-07-12');
  });

  it('starts the new training day exactly at the 04:00 cutoff', () => {
    // 2026-07-13T04:00 Asia/Shanghai
    expect(shanghaiTrainingDay(new Date('2026-07-12T20:00:00Z'))).toBe('2026-07-13');
  });

  it('crosses month boundaries backwards', () => {
    // 2026-08-01T01:30 Asia/Shanghai
    expect(shanghaiTrainingDay(new Date('2026-07-31T17:30:00Z'))).toBe('2026-07-31');
  });

  it('crosses year boundaries backwards', () => {
    // 2027-01-01T00:30 Asia/Shanghai
    expect(shanghaiTrainingDay(new Date('2026-12-31T16:30:00Z'))).toBe('2026-12-31');
  });
});
