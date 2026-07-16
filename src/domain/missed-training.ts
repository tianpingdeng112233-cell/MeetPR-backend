export interface TrainingCalendarEntry {
  date: string;
  planId: string;
  planStatus: string;
}

export interface JudgeMissedTrainingInput {
  gymDay: string;
  trainingCalendar: readonly TrainingCalendarEntry[];
  startedGymDays: ReadonlySet<string>;
  evaluationExempt: boolean;
  threshold: number;
}

export interface MissedTrainingJudgement {
  triggered: boolean;
  missedDates: string[];
  consecutiveCount: number;
  streakStartDate: string | null;
  /**
   * The last real training day (any date ≤ gymDay, planned or not) — the
   * coach-level absence-epoch anchor. All plans of one student share it, so
   * signal dedup keys on it rather than on plan-scoped streak starts.
   */
  lastTrainedDate: string | null;
  planId: string | null;
}

function exemptJudgement(): MissedTrainingJudgement {
  return {
    triggered: false,
    missedDates: [],
    consecutiveCount: 0,
    streakStartDate: null,
    lastTrainedDate: null,
    planId: null,
  };
}

/**
 * Judge one just-closed gym-day from an already shift-adjusted plan calendar.
 * Callers pass ONE plan's calendar at a time — merging plans would let one
 * coach's misses inflate another coach's streak and unbind the payload size.
 *
 * Streak boundary = the latest gym-day the student actually trained on or
 * before the judged day, whether or not it was a scheduled training day: an
 * adhoc session on a rest day proves the student showed up and ends the
 * streak. Empty rest days stay invisible — they neither count as misses nor
 * interrupt the streak.
 */
export function judgeMissedTraining(input: JudgeMissedTrainingInput): MissedTrainingJudgement {
  if (!Number.isInteger(input.threshold) || input.threshold < 1) {
    throw new RangeError('threshold must be a positive integer');
  }
  if (input.evaluationExempt) return exemptJudgement();

  const publishedByDate = new Map<string, TrainingCalendarEntry>();
  for (const entry of input.trainingCalendar) {
    if (entry.planStatus !== 'published' || entry.date > input.gymDay) continue;
    if (!publishedByDate.has(entry.date)) publishedByDate.set(entry.date, entry);
  }

  const currentDay = publishedByDate.get(input.gymDay);
  if (currentDay === undefined || input.startedGymDays.has(input.gymDay)) {
    return exemptJudgement();
  }

  let lastTrainedDate: string | null = null;
  for (const date of input.startedGymDays) {
    if (date <= input.gymDay && (lastTrainedDate === null || date > lastTrainedDate)) {
      lastTrainedDate = date;
    }
  }

  const missedDates = [...publishedByDate.keys()]
    .filter((date) => lastTrainedDate === null || date > lastTrainedDate)
    .sort();

  const consecutiveCount = missedDates.length;
  return {
    triggered: consecutiveCount >= input.threshold,
    missedDates,
    consecutiveCount,
    streakStartDate: missedDates[0] ?? null,
    lastTrainedDate,
    planId: currentDay.planId,
  };
}
