import { normalizeDateOnly, utcDate, utcDateOnly } from '../utils/date';

export interface CalendarPlan {
  start_date: string | Date;
}

export interface CalendarPlanDay {
  id: string;
  week_number: number;
  day_of_week: number;
}

export interface CalendarPlanDayShift {
  id: string;
  seq: number;
  plan_day_id: string;
  batch_id: string;
  shifted_to_date: string | Date;
  created_at: Date;
}

export interface EffectivePlanDay<TDay extends CalendarPlanDay = CalendarPlanDay> {
  day: TDay;
  effectiveDate: string;
}

/**
 * Positional plan-day semantics: day_of_week is an ordinal within the plan
 * week (1 = start_date), not the ISO weekday of start_date.
 */
export function plannedDate(
  startDate: string | Date,
  weekNumber: number,
  dayOfWeek: number,
): string {
  const start = utcDate(startDate);
  start.setUTCDate(start.getUTCDate() + (weekNumber - 1) * 7 + (dayOfWeek - 1));
  return utcDateOnly(start);
}

function shiftBatchOrderKeys(shifts: readonly CalendarPlanDayShift[]): Map<string, number> {
  const keys = new Map<string, number>();
  for (const shift of shifts) {
    const current = keys.get(shift.batch_id);
    if (current === undefined || shift.seq < current) {
      keys.set(shift.batch_id, shift.seq);
    }
  }
  return keys;
}

function shiftBatchOrderKey(
  keys: ReadonlyMap<string, number>,
  shift: CalendarPlanDayShift,
): number {
  return keys.get(shift.batch_id) ?? shift.seq;
}

export function latestShiftByDay(
  shifts: readonly CalendarPlanDayShift[],
): Map<string, CalendarPlanDayShift> {
  const batchKeys = shiftBatchOrderKeys(shifts);
  const latest = new Map<string, CalendarPlanDayShift>();
  for (const shift of shifts) {
    const current = latest.get(shift.plan_day_id);
    if (
      current === undefined ||
      shiftBatchOrderKey(batchKeys, shift) > shiftBatchOrderKey(batchKeys, current)
    ) {
      latest.set(shift.plan_day_id, shift);
    }
  }
  return latest;
}

export function effectivePlanDays<TDay extends CalendarPlanDay>(
  plan: CalendarPlan,
  days: readonly TDay[],
  shifts: readonly CalendarPlanDayShift[],
): EffectivePlanDay<TDay>[] {
  const latest = latestShiftByDay(shifts);
  return days.map((day) => {
    const shift = latest.get(day.id);
    return {
      day,
      effectiveDate:
        shift === undefined
          ? plannedDate(plan.start_date, day.week_number, day.day_of_week)
          : normalizeDateOnly(shift.shifted_to_date),
    };
  });
}

export function totalEffectivePlanShiftDays(
  plan: CalendarPlan,
  effectiveDays: readonly EffectivePlanDay[],
): number {
  return Math.max(
    0,
    ...effectiveDays.map((item) => {
      const original = plannedDate(plan.start_date, item.day.week_number, item.day.day_of_week);
      return Math.floor(
        (utcDate(item.effectiveDate).getTime() - utcDate(original).getTime()) / 86_400_000,
      );
    }),
  );
}

export function totalPlanShiftDays(
  plan: CalendarPlan,
  days: readonly CalendarPlanDay[],
  shifts: readonly CalendarPlanDayShift[],
): number {
  return totalEffectivePlanShiftDays(plan, effectivePlanDays(plan, days, shifts));
}

export function latestShiftBatch(shifts: readonly CalendarPlanDayShift[]): CalendarPlanDayShift[] {
  const first = shifts[0];
  if (first === undefined) return [];

  const batchKeys = shiftBatchOrderKeys(shifts);
  let latest = first;
  for (const shift of shifts.slice(1)) {
    if (shiftBatchOrderKey(batchKeys, shift) > shiftBatchOrderKey(batchKeys, latest)) {
      latest = shift;
    }
  }
  return shifts.filter((shift) => shift.batch_id === latest.batch_id);
}

export function effectiveDateBeforeBatch(
  plan: CalendarPlan,
  day: CalendarPlanDay,
  shifts: readonly CalendarPlanDayShift[],
  batchId: string,
): string {
  const batchKeys = shiftBatchOrderKeys(shifts);
  const targetKey = batchKeys.get(batchId);
  let previous: CalendarPlanDayShift | undefined;
  for (const shift of shifts) {
    if (shift.plan_day_id !== day.id || shift.batch_id === batchId) continue;
    const shiftKey = shiftBatchOrderKey(batchKeys, shift);
    if (targetKey !== undefined && shiftKey >= targetKey) continue;
    if (previous === undefined || shiftKey > shiftBatchOrderKey(batchKeys, previous)) {
      previous = shift;
    }
  }
  return previous === undefined
    ? plannedDate(plan.start_date, day.week_number, day.day_of_week)
    : normalizeDateOnly(previous.shifted_to_date);
}
