import { describe, expect, it } from 'vitest';

import { shanghaiTrainingDay, trainingDay } from '../../src/utils/date';

const legacyShanghaiCases = [
  ['ordinary daytime', '2026-07-13T04:00:00Z', '2026-07-13'],
  ['03:59 cutoff edge', '2026-07-12T19:59:00Z', '2026-07-12'],
  ['04:00 cutoff edge', '2026-07-12T20:00:00Z', '2026-07-13'],
  ['month boundary', '2026-07-31T17:30:00Z', '2026-07-31'],
  ['year boundary', '2026-12-31T16:30:00Z', '2026-12-31'],
] as const;

describe('trainingDay', () => {
  it.each(legacyShanghaiCases)(
    'preserves the Shanghai result at %s',
    (_label, instant, expected) => {
      const now = new Date(instant);
      expect(trainingDay(now, 'Asia/Shanghai')).toBe(expected);
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the alias equivalence is a SPEC 042 acceptance invariant
      expect(trainingDay(now, 'Asia/Shanghai')).toBe(shanghaiTrainingDay(now));
    },
  );

  it.each([
    ['Europe/London GMT 03:59', 'Europe/London', '2026-01-15T03:59:00Z', '2026-01-14'],
    ['Europe/London GMT 04:00', 'Europe/London', '2026-01-15T04:00:00Z', '2026-01-15'],
    ['Europe/London BST 03:59', 'Europe/London', '2026-07-15T02:59:00Z', '2026-07-14'],
    ['Europe/London BST 04:00', 'Europe/London', '2026-07-15T03:00:00Z', '2026-07-15'],
    [
      'America/New_York across UTC midnight',
      'America/New_York',
      '2026-07-16T01:30:00Z',
      '2026-07-15',
    ],
    ['America/New_York 04:00', 'America/New_York', '2026-07-16T08:00:00Z', '2026-07-16'],
    ['Europe/London spring DST day 03:59', 'Europe/London', '2026-03-29T02:59:00Z', '2026-03-28'],
    ['Europe/London spring DST day 04:00', 'Europe/London', '2026-03-29T03:00:00Z', '2026-03-29'],
    ['Europe/London autumn DST day 03:59', 'Europe/London', '2026-10-25T03:59:00Z', '2026-10-24'],
    ['Europe/London autumn DST day 04:00', 'Europe/London', '2026-10-25T04:00:00Z', '2026-10-25'],
  ] as const)('%s', (_label, timezone, instant, expected) => {
    expect(trainingDay(new Date(instant), timezone)).toBe(expected);
  });
});
