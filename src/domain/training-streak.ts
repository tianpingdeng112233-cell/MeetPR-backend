import { utcDate } from '../utils/date';

export interface TrainingStreakInput {
  asOf: string;
  sessionDates: readonly string[];
  plannedDates: readonly string[];
  evaluationExempt: boolean;
}

export interface TrainingStreakResult {
  current: number;
  startedOn: string | null;
  lastSessionDate: string | null;
}

/**
 * Two training sessions more than this many calendar days apart break the
 * chain regardless of scheduled days. This bounds plan-less self-training and
 * prevents a chain from staying alive forever after a published plan ends.
 * Three to four sessions a week is normal for powerlifting; fourteen empty
 * days is therefore a deliberately generous fallback.
 */
export const STREAK_MAX_GAP_DAYS = 14;

const CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;

function diffDays(later: string, earlier: string): number {
  return Math.round((utcDate(later).getTime() - utcDate(earlier).getTime()) / CALENDAR_DAY_MS);
}

function emptyStreak(): TrainingStreakResult {
  return { current: 0, startedOn: null, lastSessionDate: null };
}

/**
 * Compute the student's current training-session streak as of one gym-day.
 *
 * Session rows are status-agnostic: in_progress, completed, and partial all
 * mean the student showed up, so the first set of the day increments the
 * streak immediately. Rest days are invisible because only missed effective
 * plan dates strictly between sessions break the chain. That is intentionally
 * a threshold of one missed training day, not the alerting policy's threshold
 * for notifying a coach.
 */
export function computeTrainingStreak(input: TrainingStreakInput): TrainingStreakResult {
  // Sort ascending once so the latest session is at the end and backtracking
  // walks earlier sessions from nearest to farthest. Future data is excluded
  // before it can affect either the head or the history of the chain.
  const sessionDates = [...new Set(input.sessionDates)].filter((date) => date <= input.asOf).sort();
  const last = sessionDates.at(-1);
  if (last === undefined) return emptyStreak();

  // effectivePlanDays has already folded shifts into their destination dates;
  // there is deliberately no shift-specific branch in streak computation.
  const plannedDates = [...new Set(input.plannedDates)].filter((date) => date <= input.asOf).sort();
  const hasMissedPlanDateBetween = (earlier: string, later: string): boolean =>
    plannedDates.some((date) => earlier < date && date < later);

  if (diffDays(input.asOf, last) > STREAK_MAX_GAP_DAYS) return emptyStreak();

  // The current gym-day is still open, so a plan date equal to asOf is not a
  // miss. Incomplete evaluations suppress the same missed-training judgement
  // as daily settlement, but never suppress the maximum-gap fallback.
  if (!input.evaluationExempt && hasMissedPlanDateBetween(last, input.asOf)) {
    return emptyStreak();
  }

  let current = 1;
  let cursor = last;
  for (let index = sessionDates.length - 2; index >= 0; index -= 1) {
    const previous = sessionDates[index];
    if (previous === undefined) continue;
    if (diffDays(cursor, previous) > STREAK_MAX_GAP_DAYS) break;
    if (!input.evaluationExempt && hasMissedPlanDateBetween(previous, cursor)) break;
    current += 1;
    cursor = previous;
  }

  return { current, startedOn: cursor, lastSessionDate: last };
}
