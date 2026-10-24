import { effectivePlanDays, type CalendarPlanDayShift } from './plan-calendar';
import { normalizeDateOnly, trainingDay, utcDate, utcDateOnly } from '../utils/date';
import { DEFAULT_TIME_ZONE } from '../utils/timezone';

type DateOnly = string | Date;
export interface OverviewAlertsInput {
  now: Date;
  students: { id: string; timezone: string }[];
  views: { student_id: string; seen_at: Date }[];
  plans: {
    id: string;
    trainee_id: string;
    name: string;
    status: string;
    start_date: DateOnly;
    end_date: DateOnly;
  }[];
  days: { id: string; plan_id: string; week_number: number; day_of_week: number }[];
  shifts: CalendarPlanDayShift[];
  sets: {
    plan_exercise_id: string;
    plan_day_id: string;
    exercise_id: string;
    set_number: number;
    load_mode: string | null;
    target_rpe: string | number | null;
    rpe_high: string | number | null;
  }[];
  logs: {
    student_id: string;
    plan_exercise_id: string | null;
    set_index: number;
    rpe: string | number | null;
    coach_rpe: string | number | null;
    completed: boolean;
    failed: boolean;
    logged_date: DateOnly;
    logged_at: Date;
  }[];
  completions: { student_id: string; plan_day_id: string; completed_at: Date }[];
}
interface SetIdentity {
  date: string;
  plan_day_id: string;
  plan_exercise_id: string;
  exercise_id: string;
  set_index: number;
}
export type TrainingAlert =
  | (SetIdentity & { type: 'rpe_over'; target_rpe: string; actual_rpe: string })
  | (SetIdentity & { type: 'incomplete'; reason: 'missing' | 'failed' })
  | { type: 'behind'; recommended_date: string; plan_day_id: string; week_number: number };
export interface OverviewAlerts {
  generated_at: string;
  plan_ending: {
    student_id: string;
    plan_id: string;
    plan_name: string;
    end_date: string;
    days_left: number;
  }[];
  training: { student_id: string; latest_at: string; items: TrainingAlert[] }[];
}
const DAY_MS = 86_400_000;

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

function alertDate(item: TrainingAlert): string {
  return item.type === 'behind' ? item.recommended_date : item.date;
}

export function buildOverviewAlerts(input: OverviewAlertsInput): OverviewAlerts {
  const result: OverviewAlerts = {
    generated_at: input.now.toISOString(),
    plan_ending: [],
    training: [],
  };
  const plansByStudent = groupBy(input.plans, (plan) => plan.trainee_id);
  const daysByPlan = groupBy(input.days, (day) => day.plan_id);
  const shiftsByDay = groupBy(input.shifts, (shift) => shift.plan_day_id);
  const setsByDay = groupBy(input.sets, (set) => set.plan_day_id);
  const logsByStudent = groupBy(input.logs, (log) => log.student_id);
  const completionsByStudent = groupBy(input.completions, (row) => row.student_id);
  const views = new Map(input.views.map((view) => [view.student_id, view.seen_at]));
  for (const student of input.students) {
    const today = trainingDay(input.now, student.timezone || DEFAULT_TIME_ZONE);
    const plans = plansByStudent.get(student.id) ?? [];
    const published = plans.filter((plan) => plan.status === 'published');
    const latestPlan = published.reduce<OverviewAlertsInput['plans'][number] | undefined>(
      (latest, plan) =>
        !latest || normalizeDateOnly(plan.end_date) > normalizeDateOnly(latest.end_date)
          ? plan
          : latest,
      undefined,
    );
    if (latestPlan) {
      const endDate = normalizeDateOnly(latestPlan.end_date);
      const daysLeft = (utcDate(endDate).getTime() - utcDate(today).getTime()) / DAY_MS;
      if (
        daysLeft >= -14 &&
        daysLeft <= 3 &&
        !published.some(
          (plan) => plan.id !== latestPlan.id && normalizeDateOnly(plan.start_date) > endDate,
        )
      ) {
        result.plan_ending.push({
          student_id: student.id,
          plan_id: latestPlan.id,
          plan_name: latestPlan.name,
          end_date: endDate,
          days_left: daysLeft,
        });
      }
    }
    const timezone = student.timezone || DEFAULT_TIME_ZONE;
    // Seven training dates, inclusive of today, matching the existing event range convention.
    const from = utcDateOnly(new Date(utcDate(today).getTime() - 6 * DAY_MS));
    const inWindow = (date: string) => date >= from && date <= today;
    const seenAt = views.get(student.id);
    const afterSeen = (at: Date) => seenAt === undefined || at.getTime() > seenAt.getTime();
    const seenDay = seenAt === undefined ? undefined : trainingDay(seenAt, timezone);
    const completions = new Map(
      (completionsByStudent.get(student.id) ?? []).map((row) => [row.plan_day_id, row]),
    );
    const logsByExercise = groupBy(
      (logsByStudent.get(student.id) ?? []).filter(
        (log): log is typeof log & { plan_exercise_id: string } => log.plan_exercise_id !== null,
      ),
      (log) => log.plan_exercise_id,
    );
    const events: { item: TrainingAlert; at: Date }[] = [];
    for (const plan of plans) {
      const days = daysByPlan.get(plan.id) ?? [];
      const shifts = days.flatMap((day) => shiftsByDay.get(day.id) ?? []);
      for (const { day, effectiveDate } of effectivePlanDays(plan, days, shifts)) {
        const completion = completions.get(day.id);
        if (
          plan.status === 'published' &&
          !completion &&
          effectiveDate < today &&
          inWindow(effectiveDate) &&
          (seenDay === undefined || effectiveDate > seenDay)
        ) {
          events.push({
            item: {
              type: 'behind',
              recommended_date: effectiveDate,
              plan_day_id: day.id,
              week_number: day.week_number,
            },
            at: utcDate(effectiveDate),
          });
        }
        const exercises = groupBy(setsByDay.get(day.id) ?? [], (set) => set.plan_exercise_id);
        for (const [exerciseId, prescription] of exercises) {
          // Clients address sorted prescriptions by zero-based position. Extra sets start at count.
          const sets = [...prescription].sort((a, b) => a.set_number - b.set_number);
          const logs = new Map(
            (logsByExercise.get(exerciseId) ?? []).map((log) => [log.set_index, log]),
          );
          sets.forEach((set, setIndex) => {
            const log = logs.get(setIndex);
            const identity = {
              plan_day_id: day.id,
              plan_exercise_id: exerciseId,
              exercise_id: set.exercise_id,
              set_index: setIndex,
            };
            const target =
              set.load_mode === 'rpe'
                ? set.target_rpe
                : set.load_mode === 'rpe_range'
                  ? set.rpe_high
                  : null;
            if (log) {
              const date = normalizeDateOnly(log.logged_date);
              const actual = log.coach_rpe ?? log.rpe;
              if (
                target !== null &&
                actual !== null &&
                Number(actual) >= Number(target) + 1 &&
                inWindow(date) &&
                afterSeen(log.logged_at)
              ) {
                events.push({
                  item: {
                    ...identity,
                    type: 'rpe_over',
                    date,
                    target_rpe: Number(target).toFixed(1),
                    actual_rpe: Number(actual).toFixed(1),
                  },
                  at: log.logged_at,
                });
              }
            }
            if (completion && (!log?.completed || log.failed)) {
              const date = log
                ? normalizeDateOnly(log.logged_date)
                : trainingDay(completion.completed_at, timezone);
              // Incomplete becomes actionable when the training day is completed.
              const at = completion.completed_at;
              if (inWindow(date) && afterSeen(at)) {
                events.push({
                  item: {
                    ...identity,
                    type: 'incomplete',
                    date,
                    reason: log?.failed ? 'failed' : 'missing',
                  },
                  at,
                });
              }
            }
          });
        }
      }
    }
    const firstEvent = events[0];
    if (firstEvent !== undefined) {
      events.sort((a, b) => alertDate(b.item).localeCompare(alertDate(a.item)));
      const latestAt = events.reduce(
        (latest, event) => (event.at > latest ? event.at : latest),
        firstEvent.at,
      );
      result.training.push({
        student_id: student.id,
        latest_at: latestAt.toISOString(),
        items: events.map((event) => event.item),
      });
    }
  }
  result.training.sort((a, b) => b.latest_at.localeCompare(a.latest_at));
  return result;
}
