import { describe, expect, it } from 'vitest';
import { computeCoachPageStats, publicVerifiedStats } from '../../src/domain/coach-page-stats';
import type { ExerciseStatsAggregationLog } from '../../src/handlers/exercise-stats';
const profile = { squat_stance: null, deadlift_style: null };
function log(
  date: string,
  weight: number,
  extra: Partial<ExerciseStatsAggregationLog> = {},
): ExerciseStatsAggregationLog {
  return {
    main_lift_family: 'squat',
    is_competition_lift: true,
    competition_stance: null,
    weight_kg: weight,
    reps: 1,
    rpe: 10,
    coach_rpe: null,
    completed: true,
    failed: false,
    assumed: false,
    e1rm_confidence: 'normal',
    logged_date: date,
    ...extra,
  };
}
describe('verified coach page stats', () => {
  it('matches hand-calculated scale, lifetime baselines, 28-day current values, negative progress and median response', () => {
    const stats = computeCoachPageStats({
      now: new Date('2026-10-12T00:00:00Z'),
      firstAcceptedAt: new Date('2026-07-12T00:00:00Z'),
      activeStudentCount: 3,
      totalStudentCount: 5,
      completedSessionCount: 12,
      prCount: 7,
      students: [
        {
          profile,
          logs: [
            log('2026-01-01', 100),
            log('2026-09-01', 180),
            log('2026-10-01', 120),
            log('2026-10-01', 125),
            log('2026-10-08', 110),
            log('2026-10-01', 60, { main_lift_family: 'bench' }),
            log('2026-10-08', 65, { main_lift_family: 'bench' }),
            log('2026-10-01', 150, { main_lift_family: 'deadlift' }),
            log('2026-10-08', 150, { main_lift_family: 'deadlift' }),
            log('2026-10-09', 600, { e1rm_confidence: 'low' }),
            log('2026-10-10', 700, { failed: true }),
            log('2026-10-11', 800, { assumed: true }),
          ],
        },
        { profile, logs: [log('2026-08-01', 140), log('2026-10-01', 120)] },
        { profile, logs: [log('2026-01-01', 300, { is_competition_lift: false })] },
        { profile, logs: [log('2026-01-01', 300, { assumed: true })] },
      ],
      videos: [
        {
          createdAt: new Date('2026-10-01T00:00:00Z'),
          feedbackAt: [new Date('2026-10-01T00:30:00Z'), new Date('2026-10-01T00:10:00Z')],
        },
        {
          createdAt: new Date('2026-10-01T00:00:00Z'),
          feedbackAt: [new Date('2026-10-01T00:50:00Z')],
        },
        {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          feedbackAt: [new Date('2026-01-01T01:00:00Z')],
        },
        { createdAt: new Date('2026-10-01T00:00:00Z'), feedbackAt: [] },
      ],
    });
    expect(stats.scale).toEqual({
      training_duration: { value: 3, unit: 'months' },
      active_student_count: 3,
      total_student_count: 5,
      completed_session_count: 12,
    });
    expect(stats.progress).toEqual({
      pr_count: 7,
      students: [
        {
          display_name: '学员 A',
          lifts: {
            squat: { baseline_kg: 100, current_kg: 125, change_kg: 25, weeks: 40 },
            bench: { baseline_kg: 60, current_kg: 65, change_kg: 5, weeks: 1 },
            deadlift: { baseline_kg: 150, current_kg: 150, change_kg: 0, weeks: 1 },
          },
        },
        {
          display_name: '学员 B',
          lifts: { squat: { baseline_kg: 140, current_kg: 120, change_kg: -20, weeks: 8 } },
        },
      ],
    });
    expect(stats.response).toEqual({
      median_minutes: 30,
      value: 30,
      unit: 'minutes',
      sample_count: 2,
    });
    expect(publicVerifiedStats(stats).progress?.students[0]?.lifts.squat).toEqual({
      change_kg: 25,
      weeks: 40,
    });
  });
  it('omits empty progress and response blocks and shows weeks below one month', () => {
    const stats = computeCoachPageStats({
      now: new Date('2026-10-12T00:00:00Z'),
      firstAcceptedAt: new Date('2026-10-01T00:00:00Z'),
      activeStudentCount: 0,
      totalStudentCount: 1,
      completedSessionCount: 0,
      prCount: 0,
      students: [],
      videos: [],
    });
    expect(stats.scale.training_duration).toEqual({ value: 1, unit: 'weeks' });
    expect(stats.progress).toBeNull();
    expect(stats.response).toBeNull();
  });
});

it('includes the latest recorded training day across UTC boundaries and keeps one-day progress', () => {
  const stats = computeCoachPageStats({
    now: new Date('2026-10-11T23:30:00Z'),
    firstAcceptedAt: null,
    activeStudentCount: 1,
    totalStudentCount: 1,
    completedSessionCount: 1,
    prCount: 0,
    students: [{ profile, logs: [log('2026-10-12', 100)] }],
    videos: [],
  });
  expect(stats.progress?.students[0]?.lifts.squat).toEqual({
    baseline_kg: 100,
    current_kg: 100,
    change_kg: 0,
    weeks: 1,
  });
});

it('uses an inclusive 28-day window, half-kilo changes and the coach RPE override', () => {
  const stats = computeCoachPageStats({
    now: new Date('2026-10-28T12:00:00Z'),
    firstAcceptedAt: null,
    activeStudentCount: 1,
    totalStudentCount: 1,
    completedSessionCount: 4,
    prCount: 0,
    students: [
      {
        profile,
        logs: [
          log('2026-01-01', 100),
          log('2026-09-30', 180), // 28 days back: excluded from the current window.
          log('2026-10-01', 120.3), // 27 days back: included.
          log('2026-10-28', 110),
          log('2026-10-28', 100, { main_lift_family: 'bench', rpe: 6, coach_rpe: 10 }),
        ],
      },
    ],
    videos: [],
  });
  expect(stats.progress?.students[0]?.lifts.squat).toEqual({
    baseline_kg: 100,
    current_kg: 120.3,
    change_kg: 20.5,
    weeks: 42,
  });
  expect(stats.progress?.students[0]?.lifts.bench).toEqual({
    baseline_kg: 100,
    current_kg: 100,
    change_kg: 0,
    weeks: 1,
  });
});
