import { describe, expect, it } from 'vitest';

import { calculateEligibleE1RM, resolveCompetitionFamily } from '../../src/domain/e1rm';
import type { CompetitionStance, DeadliftStyle, LiftFamily, SquatStance } from '../../src/db/types';

const base = {
  family: 'squat' as const,
  weightKg: 100,
  reps: 5,
  rpe: null,
  completed: true,
  failed: false,
  confidence: null,
};

describe('resolveCompetitionFamily', () => {
  const resolve = (
    mainLiftFamily: LiftFamily | null,
    isCompetitionLift: boolean,
    competitionStance: CompetitionStance | null,
    squatStance: SquatStance | null = null,
    deadliftStyle: DeadliftStyle | null = null,
  ) =>
    resolveCompetitionFamily(
      {
        main_lift_family: mainLiftFamily,
        is_competition_lift: isCompetitionLift,
        competition_stance: competitionStance,
      },
      { squat_stance: squatStance, deadlift_style: deadliftStyle },
    );

  it.each([
    ['low-bar student / low-bar squat', 'low_bar', 'low_bar', 'squat'],
    ['low-bar student / high-bar squat', 'high_bar', 'low_bar', null],
    ['high-bar student / low-bar squat', 'low_bar', 'high_bar', null],
    ['high-bar student / high-bar squat', 'high_bar', 'high_bar', 'squat'],
    ['unset student / low-bar squat', 'low_bar', null, 'squat'],
    ['unset student / high-bar squat', 'high_bar', null, 'squat'],
  ] as const)('%s', (_name, competitionStance, squatStance, expected) => {
    expect(resolve('squat', false, competitionStance, squatStance)).toBe(expected);
  });

  it.each([
    ['conventional / conventional', 'conventional', 'conventional', 'deadlift'],
    ['conventional / sumo', 'sumo', 'conventional', null],
    ['sumo / conventional', 'conventional', 'sumo', null],
    ['sumo / sumo', 'sumo', 'sumo', 'deadlift'],
    ['both / conventional', 'conventional', 'both', 'deadlift'],
    ['both / sumo', 'sumo', 'both', 'deadlift'],
    ['unset / conventional', 'conventional', null, 'deadlift'],
    ['unset / sumo', 'sumo', null, 'deadlift'],
  ] as const)('%s', (_name, competitionStance, deadliftStyle, expected) => {
    expect(resolve('deadlift', true, competitionStance, null, deadliftStyle)).toBe(expected);
  });

  it('always includes generic competition squat and bench', () => {
    expect(resolve('squat', true, null, 'high_bar', 'sumo')).toBe('squat');
    expect(resolve('bench', true, null, 'low_bar', 'conventional')).toBe('bench');
  });

  it('rejects family-less exercises and unclassified variations', () => {
    expect(resolve(null, true, null)).toBeNull();
    expect(resolve('squat', false, null, 'low_bar')).toBeNull();
    expect(resolve('deadlift', false, null, null, 'conventional')).toBeNull();
  });
});

describe('e1RM policy', () => {
  it('uses Epley without RPE and the canonical RTS table from RPE 6', () => {
    expect(calculateEligibleE1RM(base)).toBeCloseTo(116.6667, 4);
    expect(calculateEligibleE1RM({ ...base, rpe: 8 })).toBeCloseTo(128.2051, 4);
    expect(calculateEligibleE1RM({ ...base, weightKg: 140, reps: 5, rpe: 6 })).toBeCloseTo(200, 4);
  });

  it('falls back to Epley below RPE 6 and rejects RPE above 10', () => {
    expect(calculateEligibleE1RM({ ...base, weightKg: 140, reps: 5, rpe: 5 })).toBeCloseTo(
      163.3333,
      4,
    );
    expect(calculateEligibleE1RM({ ...base, rpe: 10.1 })).toBeNull();
  });

  it.each([
    ['unresolved exercise family', { family: null }],
    ['incomplete', { completed: false }],
    ['failed', { failed: true }],
    ['more than 10 reps', { reps: 11 }],
    ['low confidence', { confidence: 'low' as const }],
    ['deadlift above 5 reps', { family: 'deadlift' as const, reps: 6 }],
  ])('excludes %s points', (_name, override) => {
    expect(calculateEligibleE1RM({ ...base, ...override })).toBeNull();
  });
});
