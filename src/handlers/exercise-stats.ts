import type { Kysely } from 'kysely';

import { E1RM_POLICY, calculateEligibleE1RM, resolveCompetitionFamily } from '../domain/e1rm';
import {
  LIFT_FAMILIES,
  type CompetitionStance,
  type Database,
  type DeadliftStyle,
  type LiftFamily,
  type SquatStance,
} from '../db/types';
import { trainingDay } from '../utils/date';
import { dateOnly, decimal, timestamp } from './serialization';

export const EXERCISE_STATS_LIMITS = {
  recentSessions: 5,
  sessionsPerSetCount: 3,
  overviewWindowDays: 90,
} as const;

type ScopedLog = Awaited<ReturnType<typeof fetchScopedLogs>>[number];

export type E1RMTrend = 'up' | 'flat' | 'down' | 'new';

export interface E1RMSeriesPoint {
  date: string;
  value: string;
}

export interface E1RMFamilySeries {
  points: E1RMSeriesPoint[];
  trend: E1RMTrend;
}

export type E1RMSeries = Record<LiftFamily, E1RMFamilySeries>;

export interface WeeklyVolumeByFamily {
  squat: string;
  bench: string;
  deadlift: string;
  other: string;
}

export interface WeeklyVolumePoint {
  week_start: string;
  volume_kg: string;
  avg_rpe: string | null;
  volume_by_family: WeeklyVolumeByFamily;
}

export interface WeeklyFamilyMetric {
  week_start: string;
  volume_kg: string;
  avg_rpe: string | null;
  top_set_intensity: string | null;
}

export type WeeklyFamilyMetrics = Record<LiftFamily, WeeklyFamilyMetric[]>;

export interface IntensityDistributionBucket {
  lt70: number;
  b70_80: number;
  b80_90: number;
  gte90: number;
}

export type IntensityDistribution = Record<LiftFamily, IntensityDistributionBucket>;

export interface RepDistributionBucket {
  reps: number;
  count: number;
}

export type RepDistribution = Record<LiftFamily, RepDistributionBucket[]>;

export interface ExerciseStatsTrackingAggregates {
  weekly_family_metrics: WeeklyFamilyMetrics;
  intensity_distribution: IntensityDistribution;
  rep_distribution: RepDistribution;
}

export interface ExerciseStatsOverviewResponse {
  exercises: {
    exercise_id: string;
    name: string;
    session_count: number;
    last_logged_at: string;
  }[];
  one_rm: Record<LiftFamily, string | null>;
  e1rm: Record<LiftFamily, { value: string; computed_at: string } | null>;
  last_trained_at: string | null;
  recent_4w: {
    trained_days: number;
    total_planned_days: number;
    completion_rate: number;
  };
  e1rm_series: E1RMSeries;
  weekly_volume: WeeklyVolumePoint[];
  weekly_family_metrics: WeeklyFamilyMetrics;
  intensity_distribution: IntensityDistribution;
  rep_distribution: RepDistribution;
}

export interface ExerciseStatsAggregationLog {
  main_lift_family: LiftFamily | null;
  is_competition_lift: boolean;
  competition_stance: CompetitionStance | null;
  weight_kg: string | number;
  reps: number;
  rpe: string | number | null;
  coach_rpe: string | number | null;
  completed: boolean;
  failed: boolean;
  assumed: boolean;
  e1rm_confidence: 'normal' | 'low' | null;
  logged_date: string | Date;
}

export interface ExerciseStatsCompetitionProfile {
  squat_stance: SquatStance | null;
  deadlift_style: DeadliftStyle | null;
}

async function fetchScopedLogs(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  exerciseId?: string,
) {
  let query = db
    .selectFrom('set_logs as sl')
    .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .innerJoin('exercises as e', 'e.id', 'sl.exercise_id')
    .select([
      'sl.id as id',
      'sl.exercise_id as exercise_id',
      'e.name as exercise_name',
      'e.main_lift_family as main_lift_family',
      'e.is_competition_lift as is_competition_lift',
      'e.competition_stance as competition_stance',
      'sl.set_index as set_index',
      'sl.weight_kg as weight_kg',
      'sl.reps as reps',
      'sl.rpe as rpe',
      'sl.coach_rpe as coach_rpe',
      'sl.completed as completed',
      'sl.failed as failed',
      'sl.assumed as assumed',
      'sl.e1rm_confidence as e1rm_confidence',
      'sl.logged_date as logged_date',
      'sl.logged_at as logged_at',
    ])
    .where('sl.student_id', '=', studentId)
    .where('p.coach_id', '=', coachId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', 'in', ['published', 'paused', 'completed']);
  if (exerciseId !== undefined) query = query.where('sl.exercise_id', '=', exerciseId);
  return query.orderBy('sl.logged_at', 'desc').execute();
}

async function onboardingSnapshot(db: Kysely<Database>, studentId: string) {
  const row = await db
    .selectFrom('student_onboarding_profiles')
    .select(['squat_1rm_kg', 'bench_1rm_kg', 'deadlift_1rm_kg', 'squat_stance', 'deadlift_style'])
    .where('user_id', '=', studentId)
    .executeTakeFirst();
  return {
    oneRm: {
      squat: decimal(row?.squat_1rm_kg ?? null, 2),
      bench: decimal(row?.bench_1rm_kg ?? null, 2),
      deadlift: decimal(row?.deadlift_1rm_kg ?? null, 2),
    },
    squat_stance: row?.squat_stance ?? null,
    deadlift_style: row?.deadlift_style ?? null,
  };
}

async function studentTimezone(db: Kysely<Database>, studentId: string): Promise<string> {
  const user = await db
    .selectFrom('users')
    .select('timezone')
    .where('id', '=', studentId)
    .executeTakeFirstOrThrow();
  return user.timezone;
}

function utcDate(value: string | Date): Date {
  return new Date(`${dateOnly(value)}T00:00:00.000Z`);
}

function shiftedDate(value: string, days: number): string {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveWindowStart(end: string, days: number): string {
  return shiftedDate(end, -(days - 1));
}

function mondayOfWeek(value: string): string {
  const date = utcDate(value);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function effectiveRpe(log: ExerciseStatsAggregationLog): number | null {
  const value = log.coach_rpe ?? log.rpe;
  return value === null ? null : Number(value);
}

export function classifyE1RMTrend(
  currentBest: number | null,
  previousBest: number | null,
): E1RMTrend {
  if (previousBest === null) return 'new';
  if (currentBest === null) return 'down';
  if (currentBest > previousBest * (1 + E1RM_POLICY.prNoiseRatio)) return 'up';
  if (currentBest < previousBest * (1 - E1RM_POLICY.prNoiseRatio)) return 'down';
  return 'flat';
}

export function buildE1RMSeries(
  logs: ExerciseStatsAggregationLog[],
  onboarding: ExerciseStatsCompetitionProfile,
  endDate: string,
): E1RMSeries {
  const chartStart = inclusiveWindowStart(endDate, EXERCISE_STATS_LIMITS.overviewWindowDays);
  const currentStart = inclusiveWindowStart(endDate, E1RM_POLICY.rollingWindowDays);
  const previousEnd = shiftedDate(currentStart, -1);
  const previousStart = inclusiveWindowStart(previousEnd, E1RM_POLICY.rollingWindowDays);
  const bestByFamilyAndDate: Record<LiftFamily, Map<string, number>> = {
    squat: new Map(),
    bench: new Map(),
    deadlift: new Map(),
  };

  for (const log of logs) {
    const date = dateOnly(log.logged_date);
    if (log.assumed || date < chartStart || date > endDate) continue;
    const family = resolveCompetitionFamily(log, onboarding);
    const value = calculateEligibleE1RM({
      family,
      weightKg: Number(log.weight_kg),
      reps: log.reps,
      rpe: effectiveRpe(log),
      completed: log.completed,
      failed: log.failed,
      confidence: log.e1rm_confidence,
    });
    if (family === null || value === null) continue;
    const current = bestByFamilyAndDate[family].get(date);
    if (current === undefined || value > current) bestByFamilyAndDate[family].set(date, value);
  }

  const result = {} as E1RMSeries;
  for (const family of LIFT_FAMILIES) {
    const values = [...bestByFamilyAndDate[family].entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => ({ date, value }));
    const bestInWindow = (start: string, end: string): number | null => {
      const candidates = values.filter((point) => point.date >= start && point.date <= end);
      return candidates.length === 0 ? null : Math.max(...candidates.map((point) => point.value));
    };
    result[family] = {
      points: values.map((point) => ({ date: point.date, value: point.value.toFixed(2) })),
      trend: classifyE1RMTrend(
        bestInWindow(currentStart, endDate),
        bestInWindow(previousStart, previousEnd),
      ),
    };
  }
  return result;
}

interface WeeklyVolumeAccumulator {
  volumeHundredths: number;
  rpeTotal: number;
  rpeCount: number;
  volumeByFamily: Record<LiftFamily | 'other', number>;
}

function emptyWeeklyVolumeAccumulator(): WeeklyVolumeAccumulator {
  return {
    volumeHundredths: 0,
    rpeTotal: 0,
    rpeCount: 0,
    volumeByFamily: { squat: 0, bench: 0, deadlift: 0, other: 0 },
  };
}

function volumeString(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}

export function buildWeeklyVolume(
  logs: ExerciseStatsAggregationLog[],
  endDate: string,
): WeeklyVolumePoint[] {
  const startDate = inclusiveWindowStart(endDate, EXERCISE_STATS_LIMITS.overviewWindowDays);
  const buckets = new Map<string, WeeklyVolumeAccumulator>();

  for (const log of logs) {
    const date = dateOnly(log.logged_date);
    if (!log.completed || log.assumed || date < startDate || date > endDate) continue;
    const weekStart = mondayOfWeek(date);
    const bucket = buckets.get(weekStart) ?? emptyWeeklyVolumeAccumulator();
    const family = log.main_lift_family ?? 'other';
    const volumeHundredths = Math.round(Number(log.weight_kg) * 100) * log.reps;
    bucket.volumeHundredths += volumeHundredths;
    bucket.volumeByFamily[family] += volumeHundredths;
    if (log.rpe !== null) {
      bucket.rpeTotal += Number(log.rpe);
      bucket.rpeCount += 1;
    }
    buckets.set(weekStart, bucket);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([weekStart, bucket]) => ({
      week_start: weekStart,
      volume_kg: volumeString(bucket.volumeHundredths),
      avg_rpe: bucket.rpeCount === 0 ? null : (bucket.rpeTotal / bucket.rpeCount).toFixed(2),
      volume_by_family: {
        squat: volumeString(bucket.volumeByFamily.squat),
        bench: volumeString(bucket.volumeByFamily.bench),
        deadlift: volumeString(bucket.volumeByFamily.deadlift),
        other: volumeString(bucket.volumeByFamily.other),
      },
    }));
}

interface WeeklyFamilyAccumulator {
  volumeHundredths: number;
  rpeTotal: number;
  rpeCount: number;
  topSet: { date: string; weightKg: number } | null;
}

function emptyWeeklyFamilyAccumulator(): WeeklyFamilyAccumulator {
  return { volumeHundredths: 0, rpeTotal: 0, rpeCount: 0, topSet: null };
}

function emptyIntensityDistribution(): IntensityDistribution {
  return {
    squat: { lt70: 0, b70_80: 0, b80_90: 0, gte90: 0 },
    bench: { lt70: 0, b70_80: 0, b80_90: 0, gte90: 0 },
    deadlift: { lt70: 0, b70_80: 0, b80_90: 0, gte90: 0 },
  };
}

function emptyRepDistribution(): RepDistribution {
  return {
    squat: Array.from({ length: 8 }, (_, index) => ({ reps: index + 1, count: 0 })),
    bench: Array.from({ length: 8 }, (_, index) => ({ reps: index + 1, count: 0 })),
    deadlift: Array.from({ length: 8 }, (_, index) => ({ reps: index + 1, count: 0 })),
  };
}

function e1rmAtDate(series: E1RMFamilySeries, date: string): number | null {
  let latest: E1RMSeriesPoint | null = null;
  for (const point of series.points) {
    if (point.date <= date && (latest === null || point.date > latest.date)) latest = point;
  }
  if (latest === null) return null;
  const value = Number(latest.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function addIntensityBucket(bucket: IntensityDistributionBucket, intensity: number): void {
  if (intensity < 70) bucket.lt70 += 1;
  else if (intensity < 80) bucket.b70_80 += 1;
  else if (intensity < 90) bucket.b80_90 += 1;
  else bucket.gte90 += 1;
}

export function buildTrackingAggregates(
  logs: ExerciseStatsAggregationLog[],
  e1rmSeries: E1RMSeries,
  endDate: string,
): ExerciseStatsTrackingAggregates {
  const startDate = inclusiveWindowStart(endDate, EXERCISE_STATS_LIMITS.overviewWindowDays);
  const weeklyBuckets: Record<LiftFamily, Map<string, WeeklyFamilyAccumulator>> = {
    squat: new Map(),
    bench: new Map(),
    deadlift: new Map(),
  };
  const intensityDistribution = emptyIntensityDistribution();
  const repDistribution = emptyRepDistribution();

  for (const log of logs) {
    const date = dateOnly(log.logged_date);
    const family = log.main_lift_family;
    if (family === null || !log.completed || log.assumed || date < startDate || date > endDate) {
      continue;
    }

    const weekStart = mondayOfWeek(date);
    const weekly = weeklyBuckets[family].get(weekStart) ?? emptyWeeklyFamilyAccumulator();
    const weightKg = Number(log.weight_kg);
    weekly.volumeHundredths += Math.round(weightKg * 100) * log.reps;
    const rpe = effectiveRpe(log);
    if (rpe !== null) {
      weekly.rpeTotal += rpe;
      weekly.rpeCount += 1;
    }
    if (
      weekly.topSet === null ||
      weightKg > weekly.topSet.weightKg ||
      (weightKg === weekly.topSet.weightKg && date > weekly.topSet.date)
    ) {
      weekly.topSet = { date, weightKg };
    }
    weeklyBuckets[family].set(weekStart, weekly);

    const denominator = e1rmAtDate(e1rmSeries[family], date);
    if (denominator !== null) {
      addIntensityBucket(intensityDistribution[family], (weightKg / denominator) * 100);
    }

    if (log.reps >= 1) {
      const repIndex = Math.min(log.reps, 8) - 1;
      const repBucket = repDistribution[family][repIndex];
      if (repBucket !== undefined) repBucket.count += 1;
    }
  }

  const weeklyFamilyMetrics = {} as WeeklyFamilyMetrics;
  for (const family of LIFT_FAMILIES) {
    weeklyFamilyMetrics[family] = [...weeklyBuckets[family].entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([weekStart, bucket]) => {
        const denominator =
          bucket.topSet === null ? null : e1rmAtDate(e1rmSeries[family], bucket.topSet.date);
        return {
          week_start: weekStart,
          volume_kg: volumeString(bucket.volumeHundredths),
          avg_rpe: bucket.rpeCount === 0 ? null : (bucket.rpeTotal / bucket.rpeCount).toFixed(2),
          top_set_intensity:
            bucket.topSet === null || denominator === null
              ? null
              : ((bucket.topSet.weightKg / denominator) * 100).toFixed(1),
        };
      });
  }

  return {
    weekly_family_metrics: weeklyFamilyMetrics,
    intensity_distribution: intensityDistribution,
    rep_distribution: repDistribution,
  };
}

function plannedDate(startDate: string | Date, weekNumber: number, dayOfWeek: number): string {
  const date = utcDate(startDate);
  date.setUTCDate(date.getUTCDate() + (weekNumber - 1) * 7 + (dayOfWeek - 1));
  return date.toISOString().slice(0, 10);
}

async function recentPlanDates(db: Kysely<Database>, coachId: string, studentId: string) {
  const rows = await db
    .selectFrom('plan_days as pd')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select(['p.start_date', 'pd.week_number', 'pd.day_of_week'])
    .where('p.coach_id', '=', coachId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', 'in', ['published', 'paused', 'completed'])
    .execute();
  return rows.map((row) => plannedDate(row.start_date, row.week_number, row.day_of_week));
}

export async function fetchExerciseStatsOverview(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
): Promise<ExerciseStatsOverviewResponse> {
  const [logs, onboarding, planDates, timezone] = await Promise.all([
    fetchScopedLogs(db, coachId, studentId),
    onboardingSnapshot(db, studentId),
    recentPlanDates(db, coachId, studentId),
    studentTimezone(db, studentId),
  ]);

  const byExercise = new Map<
    string,
    { name: string; dates: Set<string>; lastLoggedAt: Date | string }
  >();
  for (const log of logs) {
    const current = byExercise.get(log.exercise_id);
    if (current) {
      current.dates.add(dateOnly(log.logged_date));
    } else {
      byExercise.set(log.exercise_id, {
        name: log.exercise_name,
        dates: new Set([dateOnly(log.logged_date)]),
        lastLoggedAt: log.logged_at,
      });
    }
  }

  const today = trainingDay(new Date(), timezone);
  const windowStart = utcDate(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - (E1RM_POLICY.rollingWindowDays - 1));
  const start = windowStart.toISOString().slice(0, 10);
  const end = today;
  const totalPlannedDays = new Set(planDates.filter((date) => date >= start && date <= end)).size;
  const trainedDays = new Set(
    logs
      .filter(
        (log) =>
          !log.assumed &&
          log.completed &&
          dateOnly(log.logged_date) >= start &&
          dateOnly(log.logged_date) <= end,
      )
      .map((log) => dateOnly(log.logged_date)),
  ).size;
  const logsForFamily = (family: LiftFamily) =>
    logs.filter(
      (log) =>
        resolveCompetitionFamily(
          {
            main_lift_family: log.main_lift_family,
            is_competition_lift: log.is_competition_lift,
            competition_stance: log.competition_stance,
          },
          onboarding,
        ) === family,
    );
  const e1rmSeries = buildE1RMSeries(logs, onboarding, end);
  const trackingAggregates = buildTrackingAggregates(logs, e1rmSeries, end);

  return {
    exercises: [...byExercise.entries()].map(([exerciseId, value]) => ({
      exercise_id: exerciseId,
      name: value.name,
      session_count: value.dates.size,
      last_logged_at: timestamp(value.lastLoggedAt),
    })),
    one_rm: onboarding.oneRm,
    e1rm: {
      squat: currentE1rm(logsForFamily('squat'), 'squat'),
      bench: currentE1rm(logsForFamily('bench'), 'bench'),
      deadlift: currentE1rm(logsForFamily('deadlift'), 'deadlift'),
    },
    last_trained_at: logs[0] ? timestamp(logs[0].logged_at) : null,
    recent_4w: {
      trained_days: trainedDays,
      total_planned_days: totalPlannedDays,
      completion_rate:
        totalPlannedDays === 0
          ? 0
          : Math.min(1, Number((trainedDays / totalPlannedDays).toFixed(4))),
    },
    e1rm_series: e1rmSeries,
    weekly_volume: buildWeeklyVolume(logs, end),
    ...trackingAggregates,
  };
}

function groupedSessions(logs: ScopedLog[]) {
  const sessions = new Map<string, ScopedLog[]>();
  for (const log of logs) {
    const date = dateOnly(log.logged_date);
    const rows = sessions.get(date) ?? [];
    rows.push(log);
    sessions.set(date, rows);
  }
  return [...sessions.entries()].map(([date, rows]) => ({ date, rows }));
}

function repPrs(logs: ScopedLog[]) {
  const bestByReps = new Map<number, ScopedLog>();
  for (const log of logs) {
    if (!log.completed || log.failed || Number(log.weight_kg) <= 0) continue;
    const current = bestByReps.get(log.reps);
    if (!current || Number(log.weight_kg) > Number(current.weight_kg)) {
      bestByReps.set(log.reps, log);
    }
  }
  return [...bestByReps.entries()]
    .sort(([left], [right]) => left - right)
    .map(([reps, log]) => ({
      reps,
      weight_kg: Number(log.weight_kg).toFixed(2),
      logged_at: timestamp(log.logged_at),
      source: log.assumed ? ('imported' as const) : ('logged' as const),
    }));
}

function currentE1rm(logs: ScopedLog[], family: LiftFamily | null) {
  const points = logs.flatMap((log) => {
    if (log.assumed) return [];
    const value = calculateEligibleE1RM({
      family,
      weightKg: Number(log.weight_kg),
      reps: log.reps,
      rpe:
        log.coach_rpe === null
          ? log.rpe === null
            ? null
            : Number(log.rpe)
          : Number(log.coach_rpe),
      completed: log.completed,
      failed: log.failed,
      confidence: log.e1rm_confidence,
    });
    return value === null ? [] : [{ value, computedAt: log.logged_at }];
  });
  if (points.length === 0) return null;
  const latest = Math.max(...points.map((point) => new Date(point.computedAt).getTime()));
  const start = latest - E1RM_POLICY.rollingWindowDays * 24 * 60 * 60 * 1000;
  const winner = points
    .filter((point) => new Date(point.computedAt).getTime() >= start)
    .reduce((best, point) => (point.value > best.value ? point : best));
  return { value: winner.value.toFixed(2), computed_at: timestamp(winner.computedAt) };
}

export async function fetchExerciseStatsDetail(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  exerciseId: string,
) {
  const [logs, onboarding, exercise] = await Promise.all([
    fetchScopedLogs(db, coachId, studentId, exerciseId),
    onboardingSnapshot(db, studentId),
    db
      .selectFrom('exercises')
      .select(['main_lift_family', 'is_competition_lift', 'competition_stance'])
      .where('id', '=', exerciseId)
      .executeTakeFirst(),
  ]);
  const logIds = logs.map((log) => log.id);
  const videoRows =
    logIds.length === 0
      ? []
      : await db
          .selectFrom('attachments')
          .select('set_log_id')
          .where('owner_id', '=', studentId)
          .where('kind', '=', 'set_video')
          .where('status', '=', 'ready')
          .where('set_log_id', 'in', logIds)
          .execute();
  const videoLogIds = new Set(videoRows.flatMap((row) => (row.set_log_id ? [row.set_log_id] : [])));
  const sessions = groupedSessions(logs);
  const recentSessions = sessions.slice(0, EXERCISE_STATS_LIMITS.recentSessions).map((session) => ({
    date: session.date,
    sets: [...session.rows]
      .sort((left, right) => left.set_index - right.set_index)
      .map((log) => ({
        set_index: log.set_index,
        weight_kg: Number(log.weight_kg).toFixed(2),
        reps: log.reps,
        rpe: log.rpe === null ? null : Number(log.rpe).toFixed(1),
        completed: log.completed,
        failed: log.failed,
        assumed: log.assumed,
        has_video: videoLogIds.has(log.id),
      })),
  }));

  const bySetCount: Record<
    string,
    {
      date: string;
      set_count: number;
      best_weight_kg: string;
      total_reps: number;
      completed_sets: number;
    }[]
  > = {};
  for (const session of sessions) {
    const key = String(session.rows.length);
    const bucket = bySetCount[key] ?? [];
    if (bucket.length >= EXERCISE_STATS_LIMITS.sessionsPerSetCount) continue;
    bucket.push({
      date: session.date,
      set_count: session.rows.length,
      best_weight_kg: Math.max(...session.rows.map((log) => Number(log.weight_kg))).toFixed(2),
      total_reps: session.rows.reduce((sum, log) => sum + log.reps, 0),
      completed_sets: session.rows.filter((log) => log.completed).length,
    });
    bySetCount[key] = bucket;
  }

  const family = exercise
    ? resolveCompetitionFamily(
        {
          main_lift_family: exercise.main_lift_family,
          is_competition_lift: exercise.is_competition_lift,
          competition_stance: exercise.competition_stance,
        },
        onboarding,
      )
    : null;
  return {
    rep_prs: repPrs(logs),
    recent_sessions: recentSessions,
    by_set_count: bySetCount,
    e1rm: currentE1rm(logs, family),
    one_rm_reference: family === null ? null : onboarding.oneRm[family],
  };
}
