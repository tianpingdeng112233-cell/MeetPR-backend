import { describe, expect, it } from 'vitest';

import {
  buildE1RMSeries,
  buildWeeklyVolume,
  classifyE1RMTrend,
  type ExerciseStatsAggregationLog,
} from '../../src/handlers/exercise-stats';

const ONBOARDING = {
  squat_stance: 'low_bar',
  deadlift_style: 'conventional',
} as const;

function log(overrides: Partial<ExerciseStatsAggregationLog> = {}): ExerciseStatsAggregationLog {
  return {
    main_lift_family: 'squat',
    is_competition_lift: false,
    competition_stance: 'low_bar',
    weight_kg: '100.00',
    reps: 1,
    rpe: '10.0',
    completed: true,
    failed: false,
    assumed: false,
    e1rm_confidence: 'normal',
    logged_date: '2026-06-29',
    ...overrides,
  };
}

describe('exercise stats overview aggregates', () => {
  it('uses the shared e1RM qualification gates, student stance, and same-day maximum', () => {
    const series = buildE1RMSeries(
      [
        log(),
        log({ weight_kg: '105.00' }),
        log({ competition_stance: 'high_bar', weight_kg: '200.00' }),
        log({ assumed: true, weight_kg: '210.00' }),
        log({ completed: false, weight_kg: '220.00' }),
        log({ failed: true, weight_kg: '230.00' }),
        log({ e1rm_confidence: 'low', weight_kg: '240.00' }),
        log({ rpe: '6.5', weight_kg: '250.00' }),
        log({ reps: 11, weight_kg: '260.00' }),
        log({
          main_lift_family: 'deadlift',
          competition_stance: 'conventional',
          reps: 6,
          weight_kg: '300.00',
        }),
        log({ logged_date: '2026-04-01', weight_kg: '400.00' }),
      ],
      ONBOARDING,
      '2026-06-30',
    );

    expect(series.squat.points).toEqual([{ date: '2026-06-29', value: '105.00' }]);
    expect(series.bench.points).toEqual([]);
    expect(series.deadlift.points).toEqual([]);
  });

  it('classifies all four trend values with the shared 3% noise threshold', () => {
    expect(classifyE1RMTrend(104, 100)).toBe('up');
    expect(classifyE1RMTrend(96, 100)).toBe('down');
    expect(classifyE1RMTrend(103, 100)).toBe('flat');
    expect(classifyE1RMTrend(100, null)).toBe('new');
    expect(classifyE1RMTrend(null, 100)).toBe('down');
  });

  it('compares the best e1RM in adjacent 28-day windows', () => {
    const series = buildE1RMSeries(
      [log({ logged_date: '2026-06-01' }), log({ logged_date: '2026-06-29', weight_kg: '104.00' })],
      ONBOARDING,
      '2026-06-30',
    );

    expect(series.squat.trend).toBe('up');
  });

  it('sums only completed non-assumed sets and averages only present RPE values', () => {
    const weekly = buildWeeklyVolume(
      [
        log({
          logged_date: '2026-06-22',
          main_lift_family: 'deadlift',
          competition_stance: 'conventional',
          weight_kg: '110.00',
          reps: 5,
          rpe: '9.0',
        }),
        log({ logged_date: '2026-06-29', weight_kg: '100.50', reps: 5, rpe: '7.5' }),
        log({
          logged_date: '2026-06-29',
          main_lift_family: 'bench',
          competition_stance: null,
          weight_kg: '60.00',
          reps: 10,
          rpe: null,
        }),
        log({
          logged_date: '2026-06-30',
          main_lift_family: null,
          competition_stance: null,
          weight_kg: '10.00',
          reps: 4,
          rpe: '8.5',
        }),
        log({ completed: false, weight_kg: '200.00', reps: 2, rpe: '10.0' }),
        log({ assumed: true, weight_kg: '300.00', reps: 3, rpe: '10.0' }),
      ],
      '2026-06-30',
    );

    expect(weekly).toEqual([
      {
        week_start: '2026-06-22',
        volume_kg: '550.00',
        avg_rpe: '9.00',
        volume_by_family: {
          squat: '0.00',
          bench: '0.00',
          deadlift: '550.00',
          other: '0.00',
        },
      },
      {
        week_start: '2026-06-29',
        volume_kg: '1142.50',
        avg_rpe: '8.00',
        volume_by_family: {
          squat: '502.50',
          bench: '600.00',
          deadlift: '0.00',
          other: '40.00',
        },
      },
    ]);
  });
});
