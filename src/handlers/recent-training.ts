import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { effectivePlanDays } from '../domain/plan-calendar';
import { normalizeDateOnly, shanghaiTrainingDay, utcDate, utcDateOnly } from '../utils/date';

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETE_WEEK_COUNT = 4;

export interface RecentWeekActivity {
  trained_days: number;
  planned_days: number;
}

interface CompleteWeek {
  start: string;
  end: string;
}

function recentCompleteWeeks(now: Date): CompleteWeek[] {
  const currentGymDay = utcDate(shanghaiTrainingDay(now));
  const daysSinceMonday = (currentGymDay.getUTCDay() + 6) % 7;
  const currentMonday = new Date(currentGymDay.getTime() - daysSinceMonday * DAY_MS);
  const oldestMonday = new Date(currentMonday.getTime() - COMPLETE_WEEK_COUNT * 7 * DAY_MS);

  return Array.from({ length: COMPLETE_WEEK_COUNT }, (_, index) => {
    const start = new Date(oldestMonday.getTime() + index * 7 * DAY_MS);
    const end = new Date(start.getTime() + 6 * DAY_MS);
    return { start: utcDateOnly(start), end: utcDateOnly(end) };
  });
}

export function recentFourWeekActivity(
  plannedDates: Iterable<string>,
  trainedDates: Iterable<string>,
  now: Date = new Date(),
): RecentWeekActivity[] {
  const planned = new Set(plannedDates);
  const trained = new Set(trainedDates);
  return recentCompleteWeeks(now).map((week) => ({
    trained_days: [...trained].filter((date) => date >= week.start && date <= week.end).length,
    planned_days: [...planned].filter((date) => date >= week.start && date <= week.end).length,
  }));
}

export function totalRecentFourWeekActivity(weeks: readonly RecentWeekActivity[]): {
  trainedDays: number;
  plannedDays: number;
} {
  return weeks.reduce(
    (total, week) => ({
      trainedDays: total.trainedDays + week.trained_days,
      plannedDays: total.plannedDays + week.planned_days,
    }),
    { trainedDays: 0, plannedDays: 0 },
  );
}

/**
 * Batch all roster students together. Queries are split by table family and
 * deduplicated in JS because pg-mem cannot reliably aggregate DISTINCT values
 * across the plan/log joins used here.
 */
export async function fetchRecentFourWeekActivity(
  db: Kysely<Database>,
  coachId: string,
  studentIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, RecentWeekActivity[]>> {
  if (studentIds.length === 0) return new Map();

  const weeks = recentCompleteWeeks(now);
  const windowStart = weeks[0]?.start;
  const windowEnd = weeks.at(-1)?.end;
  if (windowStart === undefined || windowEnd === undefined) {
    throw new Error('Recent four-week window was unexpectedly empty');
  }

  const [planRows, logRows] = await Promise.all([
    db
      .selectFrom('plan_days as pd')
      .innerJoin('plans as p', 'p.id', 'pd.plan_id')
      .select([
        'p.id as plan_id',
        'p.trainee_id as student_id',
        'p.start_date as start_date',
        'pd.id as day_id',
        'pd.week_number as week_number',
        'pd.day_of_week as day_of_week',
      ])
      .where('p.coach_id', '=', coachId)
      .where('p.trainee_id', 'in', studentIds)
      .where('p.status', 'in', ['published', 'paused', 'completed'])
      .execute(),
    db
      .selectFrom('set_logs as sl')
      .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
      .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
      .innerJoin('plans as p', 'p.id', 'pd.plan_id')
      .select(['sl.student_id as student_id', 'sl.logged_date as logged_date'])
      .where('p.coach_id', '=', coachId)
      .whereRef('p.trainee_id', '=', 'sl.student_id')
      .where('p.status', 'in', ['published', 'paused', 'completed'])
      .where('sl.student_id', 'in', studentIds)
      .where('sl.completed', '=', true)
      // completed=true does not imply success: 0017 allows failed attempts to
      // stay completed. The shared recent-4w caliber (exercise-stats) counts
      // successful sets only.
      .where('sl.failed', '=', false)
      .where('sl.assumed', '=', false)
      .where('sl.logged_date', '>=', windowStart)
      .where('sl.logged_date', '<=', windowEnd)
      .execute(),
  ]);

  const dayIds = planRows.map((row) => row.day_id);
  const shiftRows =
    dayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_day_shifts')
          .select(['id', 'plan_day_id', 'batch_id', 'shifted_to_date', 'created_at'])
          .where('plan_day_id', 'in', dayIds)
          .execute();

  const planById = new Map<
    string,
    {
      studentId: string;
      start_date: string;
      days: { id: string; week_number: number; day_of_week: number }[];
    }
  >();
  for (const row of planRows) {
    const plan = planById.get(row.plan_id) ?? {
      studentId: row.student_id,
      start_date: row.start_date,
      days: [],
    };
    plan.days.push({
      id: row.day_id,
      week_number: row.week_number,
      day_of_week: row.day_of_week,
    });
    planById.set(row.plan_id, plan);
  }

  const plannedByStudent = new Map(studentIds.map((studentId) => [studentId, new Set<string>()]));
  for (const plan of planById.values()) {
    const dates = plannedByStudent.get(plan.studentId);
    if (dates === undefined) continue;
    for (const effective of effectivePlanDays(plan, plan.days, shiftRows)) {
      dates.add(effective.effectiveDate);
    }
  }

  const trainedByStudent = new Map(studentIds.map((studentId) => [studentId, new Set<string>()]));
  for (const row of logRows) {
    trainedByStudent.get(row.student_id)?.add(normalizeDateOnly(row.logged_date));
  }

  return new Map(
    studentIds.map((studentId) => [
      studentId,
      recentFourWeekActivity(
        plannedByStudent.get(studentId) ?? [],
        trainedByStudent.get(studentId) ?? [],
        now,
      ),
    ]),
  );
}
