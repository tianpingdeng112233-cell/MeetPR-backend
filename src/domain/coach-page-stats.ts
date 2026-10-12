import { LIFT_FAMILIES, type LiftFamily } from '../db/types';
import {
  buildE1RMSeries,
  type ExerciseStatsAggregationLog,
  type ExerciseStatsCompetitionProfile,
} from '../handlers/exercise-stats';
import { dateOnly } from '../handlers/serialization';
import { E1RM_POLICY } from './e1rm';

const DAY_MS = 86_400_000;
export interface CoachPageStatsInput {
  now: Date;
  firstAcceptedAt: Date | null;
  activeStudentCount: number;
  totalStudentCount: number;
  completedSessionCount: number;
  prCount: number;
  students: { profile: ExerciseStatsCompetitionProfile; logs: ExerciseStatsAggregationLog[] }[];
  videos: { createdAt: Date; feedbackAt: Date[] }[];
}
interface LiftProgress {
  baseline_kg: number;
  current_kg: number;
  change_kg: number;
  weeks: number;
}
function anonymousLabel(index: number): string {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return `学员 ${label}`;
}
function trainingDuration(first: Date | null, now: Date) {
  if (!first) return null;
  const months =
    (now.getUTCFullYear() - first.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    first.getUTCMonth() -
    (now.getUTCDate() < first.getUTCDate() ? 1 : 0);
  return months >= 1
    ? { value: months, unit: 'months' as const }
    : {
        value: Math.max(0, Math.floor((now.getTime() - first.getTime()) / (7 * DAY_MS))),
        unit: 'weeks' as const,
      };
}
export function computeCoachPageStats(input: CoachPageStatsInput) {
  const rows = input.students
    .map(({ profile, logs }) => {
      // Lifetime baseline, with precisely the existing daily-best eligibility rules.
      // The athlete's recorded training day can already be tomorrow relative to UTC.
      const lastLoggedDate = logs
        .map((log) => dateOnly(log.logged_date))
        .sort()
        .at(-1);
      const series = buildE1RMSeries(
        logs,
        profile,
        lastLoggedDate ?? input.now.toISOString().slice(0, 10),
        '0001-01-01',
      );
      const lifts: Partial<Record<LiftFamily, LiftProgress>> = {};
      let longest = 0;
      for (const family of LIFT_FAMILIES) {
        const points = series[family].points;
        const first = points[0];
        const last = points.at(-1);
        if (!first || !last) continue;
        const end = new Date(last.date).getTime();
        const start = end - (E1RM_POLICY.rollingWindowDays - 1) * DAY_MS;
        const current = Math.max(
          ...points.filter((p) => new Date(p.date).getTime() >= start).map((p) => Number(p.value)),
        );
        const weeks = Math.max(
          1,
          Math.floor((end - new Date(first.date).getTime()) / (7 * DAY_MS)),
        );
        lifts[family] = {
          baseline_kg: Number(first.value),
          current_kg: current,
          change_kg: Math.round((current - Number(first.value)) * 2) / 2,
          weeks,
        };
        longest = Math.max(longest, weeks);
      }
      return { lifts, longest };
    })
    .filter((r) => r.longest > 0)
    .sort((a, b) => b.longest - a.longest);
  const durations = input.videos
    .flatMap((video) => {
      const created = video.createdAt.getTime();
      if (created < input.now.getTime() - 90 * DAY_MS || created > input.now.getTime()) return [];
      const times = video.feedbackAt
        .map((d) => d.getTime())
        .filter((t) => t >= created && t <= input.now.getTime());
      return times.length ? [(Math.min(...times) - created) / 60_000] : [];
    })
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const upperMiddle = durations[middle];
  const lowerMiddle = durations[Math.floor((durations.length - 1) / 2)];
  const median =
    upperMiddle === undefined || lowerMiddle === undefined ? null : (upperMiddle + lowerMiddle) / 2;
  return {
    scale: {
      training_duration: trainingDuration(input.firstAcceptedAt, input.now),
      active_student_count: input.activeStudentCount,
      total_student_count: input.totalStudentCount,
      completed_session_count: input.completedSessionCount,
    },
    progress: rows.length
      ? {
          pr_count: input.prCount,
          students: rows.map((row, i) => ({ display_name: anonymousLabel(i), lifts: row.lifts })),
        }
      : null,
    response:
      median === null
        ? null
        : {
            median_minutes: median,
            value: Math.floor(median < 60 ? median : median / 60),
            unit: median < 60 ? ('minutes' as const) : ('hours' as const),
            sample_count: durations.length,
          },
  };
}
export type CoachPageStats = ReturnType<typeof computeCoachPageStats>;
/** Explicit public allowlist: no raw source records, identifiers or dates cross this boundary. */
export function publicVerifiedStats(stats: CoachPageStats) {
  return {
    scale: stats.scale,
    response: stats.response,
    progress:
      stats.progress === null
        ? null
        : {
            pr_count: stats.progress.pr_count,
            students: stats.progress.students.map((student) => {
              const lifts: Partial<Record<LiftFamily, { change_kg: number; weeks: number }>> = {};
              for (const family of LIFT_FAMILIES) {
                const lift = student.lifts[family];
                if (lift) lifts[family] = { change_kg: lift.change_kg, weeks: lift.weeks };
              }
              return { display_name: student.display_name, lifts };
            }),
          },
  };
}
