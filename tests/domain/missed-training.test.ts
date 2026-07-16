import { describe, expect, it } from 'vitest';

import {
  judgeMissedTraining,
  type JudgeMissedTrainingInput,
} from '../../src/domain/missed-training';

function judge(overrides: Partial<JudgeMissedTrainingInput> = {}) {
  return judgeMissedTraining({
    gymDay: '2026-07-16',
    trainingCalendar: [
      { date: '2026-07-13', planId: 'plan-a', planStatus: 'published' },
      { date: '2026-07-15', planId: 'plan-a', planStatus: 'published' },
      { date: '2026-07-16', planId: 'plan-a', planStatus: 'published' },
    ],
    startedGymDays: new Set(),
    evaluationExempt: false,
    threshold: 3,
    ...overrides,
  });
}

describe('judgeMissedTraining', () => {
  it('triggers at N with evidence dates, count, plan, and streak anchor', () => {
    expect(judge()).toEqual({
      triggered: true,
      missedDates: ['2026-07-13', '2026-07-15', '2026-07-16'],
      consecutiveCount: 3,
      streakStartDate: '2026-07-13',
      lastTrainedDate: null,
      planId: 'plan-a',
    });
  });

  it('exempts students with no published plan and ignores draft plan days', () => {
    expect(judge({ trainingCalendar: [] }).triggered).toBe(false);
    expect(
      judge({
        trainingCalendar: [{ date: '2026-07-16', planId: 'draft-plan', planStatus: 'draft' }],
        threshold: 1,
      }).triggered,
    ).toBe(false);
  });

  it('judges the shifted effective date rather than the original planned date', () => {
    const shiftedCalendar = [
      { date: '2026-07-13', planId: 'plan-a', planStatus: 'published' },
      { date: '2026-07-15', planId: 'plan-a', planStatus: 'published' },
    ];
    expect(
      judge({ gymDay: '2026-07-14', trainingCalendar: shiftedCalendar, threshold: 1 }).triggered,
    ).toBe(false);
    expect(
      judge({ gymDay: '2026-07-15', trainingCalendar: shiftedCalendar, threshold: 2 }).triggered,
    ).toBe(true);
  });

  it('does not settle a rest gym-day, while rest dates between sessions do not break the streak', () => {
    expect(judge({ gymDay: '2026-07-14', threshold: 1 }).triggered).toBe(false);
    expect(judge().missedDates).toEqual(['2026-07-13', '2026-07-15', '2026-07-16']);
  });

  it('exempts every incomplete evaluation, including a lazy-overdue one supplied by the caller', () => {
    expect(judge({ evaluationExempt: true })).toEqual({
      triggered: false,
      missedDates: [],
      consecutiveCount: 0,
      streakStartDate: null,
      lastTrainedDate: null,
      planId: null,
    });
  });

  it('treats one started scheduled gym-day as the streak boundary', () => {
    expect(judge({ startedGymDays: new Set(['2026-07-15']) })).toEqual({
      triggered: false,
      missedDates: ['2026-07-16'],
      consecutiveCount: 1,
      streakStartDate: '2026-07-16',
      lastTrainedDate: '2026-07-15',
      planId: 'plan-a',
    });
  });

  it('treats an adhoc session on a rest day as the streak boundary too', () => {
    // Planned 7-13 / 7-15 / 7-16 all unstarted, but the student trained adhoc
    // on the 7-14 rest day: the streak restarts after it (7-15, 7-16 only).
    expect(judge({ startedGymDays: new Set(['2026-07-14']) })).toEqual({
      triggered: false,
      missedDates: ['2026-07-15', '2026-07-16'],
      consecutiveCount: 2,
      streakStartDate: '2026-07-15',
      lastTrainedDate: '2026-07-14',
      planId: 'plan-a',
    });
  });

  it('ignores training after the judged gym-day when picking the boundary', () => {
    const result = judge({ startedGymDays: new Set(['2026-07-17']) });
    expect(result.triggered).toBe(true);
    expect(result.missedDates).toEqual(['2026-07-13', '2026-07-15', '2026-07-16']);
  });

  it('does not trigger below N and triggers exactly at N', () => {
    expect(judge({ threshold: 4 }).triggered).toBe(false);
    expect(judge({ threshold: 3 }).triggered).toBe(true);
  });

  it('ignores future plan days when settling a closed gym-day', () => {
    const result = judge({
      trainingCalendar: [
        { date: '2026-07-16', planId: 'plan-a', planStatus: 'published' },
        { date: '2026-07-17', planId: 'plan-a', planStatus: 'published' },
      ],
      threshold: 1,
    });
    expect(result.missedDates).toEqual(['2026-07-16']);
  });
});
