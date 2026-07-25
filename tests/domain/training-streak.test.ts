import { describe, expect, it } from 'vitest';

import {
  computeTrainingStreak,
  STREAK_MAX_GAP_DAYS,
  type TrainingStreakInput,
} from '../../src/domain/training-streak';

function compute(overrides: Partial<TrainingStreakInput> = {}) {
  return computeTrainingStreak({
    asOf: '2026-07-25',
    sessionDates: [],
    plannedDates: [],
    evaluationExempt: false,
    ...overrides,
  });
}

describe('computeTrainingStreak', () => {
  it('returns an empty streak without training records', () => {
    expect(compute()).toEqual({
      current: 0,
      startedOn: null,
      lastSessionDate: null,
    });
  });

  it('counts one session on the as-of gym-day', () => {
    expect(compute({ sessionDates: ['2026-07-25'] })).toEqual({
      current: 1,
      startedOn: '2026-07-25',
      lastSessionDate: '2026-07-25',
    });
  });

  it('keeps rest days invisible and counts adhoc sessions on them', () => {
    expect(
      compute({
        sessionDates: ['2026-07-14', '2026-07-18', '2026-07-25'],
        plannedDates: ['2026-07-14', '2026-07-25'],
      }),
    ).toEqual({
      current: 3,
      startedOn: '2026-07-14',
      lastSessionDate: '2026-07-25',
    });
  });

  it('breaks at one missed planned date between sessions', () => {
    expect(
      compute({
        sessionDates: ['2026-07-10', '2026-07-18', '2026-07-25'],
        plannedDates: ['2026-07-10', '2026-07-14', '2026-07-18', '2026-07-25'],
      }),
    ).toEqual({
      current: 2,
      startedOn: '2026-07-18',
      lastSessionDate: '2026-07-25',
    });
  });

  it('returns zero when a settled missed plan date follows the last session', () => {
    expect(
      compute({
        sessionDates: ['2026-07-18'],
        plannedDates: ['2026-07-18', '2026-07-22'],
      }),
    ).toEqual({
      current: 0,
      startedOn: null,
      lastSessionDate: null,
    });
  });

  it('does not treat an untrained plan date on asOf itself as missed', () => {
    expect(
      compute({
        sessionDates: ['2026-07-22'],
        plannedDates: ['2026-07-22', '2026-07-25'],
      }),
    ).toEqual({
      current: 1,
      startedOn: '2026-07-22',
      lastSessionDate: '2026-07-22',
    });
  });

  it('uses only shifted effective plan dates without a special-case branch', () => {
    expect(
      compute({
        sessionDates: ['2026-07-18', '2026-07-25'],
        // The original 2026-07-21 date is absent after effectivePlanDays moved it.
        plannedDates: ['2026-07-18', '2026-07-25'],
      }),
    ).toEqual({
      current: 2,
      startedOn: '2026-07-18',
      lastSessionDate: '2026-07-25',
    });
  });

  it('starts a new one-session chain after a missed planned date', () => {
    expect(
      compute({
        sessionDates: ['2026-07-14', '2026-07-25'],
        plannedDates: ['2026-07-14', '2026-07-18', '2026-07-25'],
      }),
    ).toEqual({
      current: 1,
      startedOn: '2026-07-25',
      lastSessionDate: '2026-07-25',
    });
  });

  it('breaks above the maximum gap and stays connected at the closed boundary', () => {
    expect(STREAK_MAX_GAP_DAYS).toBe(14);
    expect(
      compute({
        asOf: '2026-07-15',
        sessionDates: ['2026-07-01', '2026-07-15'],
      }).current,
    ).toBe(2);
    expect(
      compute({
        asOf: '2026-07-16',
        sessionDates: ['2026-07-01', '2026-07-16'],
      }),
    ).toEqual({
      current: 1,
      startedOn: '2026-07-16',
      lastSessionDate: '2026-07-16',
    });
    expect(
      compute({
        asOf: '2026-07-16',
        sessionDates: ['2026-07-01'],
      }),
    ).toEqual({
      current: 0,
      startedOn: null,
      lastSessionDate: null,
    });
  });

  it('bounds self-training streaks without any plan dates', () => {
    expect(
      compute({
        sessionDates: ['2026-07-14', '2026-07-18', '2026-07-25'],
      }).current,
    ).toBe(3);
    expect(
      compute({
        sessionDates: ['2026-07-01', '2026-07-25'],
      }),
    ).toEqual({
      current: 1,
      startedOn: '2026-07-25',
      lastSessionDate: '2026-07-25',
    });
  });

  it('exempts missed plan dates during evaluation but still enforces the maximum gap', () => {
    expect(
      compute({
        sessionDates: ['2026-07-14', '2026-07-25'],
        plannedDates: ['2026-07-18'],
        evaluationExempt: true,
      }).current,
    ).toBe(2);
    expect(
      compute({
        asOf: '2026-07-25',
        sessionDates: ['2026-07-01', '2026-07-25'],
        plannedDates: ['2026-07-10'],
        evaluationExempt: true,
      }),
    ).toEqual({
      current: 1,
      startedOn: '2026-07-25',
      lastSessionDate: '2026-07-25',
    });
  });

  it('ignores session and plan dates strictly after asOf', () => {
    expect(
      compute({
        asOf: '2026-07-20',
        sessionDates: ['2026-07-18', '2026-07-25'],
        plannedDates: ['2026-07-18', '2026-07-25'],
      }),
    ).toEqual({
      current: 1,
      startedOn: '2026-07-18',
      lastSessionDate: '2026-07-18',
    });
    expect(
      compute({
        asOf: '2026-07-10',
        sessionDates: ['2026-07-18'],
        plannedDates: ['2026-07-18'],
      }),
    ).toEqual({
      current: 0,
      startedOn: null,
      lastSessionDate: null,
    });
  });
});
