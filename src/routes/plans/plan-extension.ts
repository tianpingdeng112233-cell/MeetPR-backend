import { normalizeDateOnly } from '../../utils/date';
import type { PatchPlanBody } from './schemas';

interface PlanCalendar {
  start_date: string | Date;
  end_date: string | Date;
  plan_weeks: number;
}

type CalendarPatch = Pick<PatchPlanBody, 'start_date' | 'end_date' | 'plan_weeks'>;

/** Calendar-only exception to the history lock; source-template edits stay locked. */
export function isPurePlanExtension(current: PlanCalendar, patch: CalendarPatch): boolean {
  const startDate = normalizeDateOnly(current.start_date);
  const endDate = normalizeDateOnly(current.end_date);
  const mergedStartDate = patch.start_date ?? startDate;
  const mergedEndDate = patch.end_date ?? endDate;
  return (
    mergedStartDate === startDate &&
    (patch.plan_weeks === undefined ||
      (patch.plan_weeks >= current.plan_weeks && patch.plan_weeks <= 52)) &&
    mergedEndDate >= endDate &&
    mergedEndDate >= mergedStartDate
  );
}
