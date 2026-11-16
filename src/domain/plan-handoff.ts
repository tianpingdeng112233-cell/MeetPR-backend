export interface HandoffPlan {
  id: string;
  start_date: string;
  created_at: string;
  published_at: string | null;
  latest_record_at: string | null;
  days: readonly { is_rest: boolean; completed_at: string | null }[];
}

const time = (value: string | null): number => (value === null ? -Infinity : Date.parse(value));
const textOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const createdOrder = (a: HandoffPlan, b: HandoffPlan): number =>
  time(a.created_at) - time(b.created_at) || textOrder(a.id, b.id);

export function handoffOrder(a: HandoffPlan, b: HandoffPlan): number {
  return textOrder(a.start_date, b.start_date) || createdOrder(a, b);
}

export function trainingProgress(plan: HandoffPlan) {
  const days = plan.days.filter((day) => !day.is_rest);
  return {
    total_training_days: days.length,
    completed_training_days: days.filter((day) => day.completed_at !== null).length,
  };
}

export function currentPlanId(plans: readonly HandoffPlan[]): string | null {
  const anchor = plans
    .filter((plan) => plan.days.some((day) => !day.is_rest) && plan.latest_record_at !== null)
    .sort((a, b) => time(b.latest_record_at) - time(a.latest_record_at) || createdOrder(b, a))[0];
  if (anchor?.days.some((day) => !day.is_rest && day.completed_at === null)) return anchor.id;
  const next = [...plans]
    .sort(handoffOrder)
    .find(
      (plan) =>
        (!anchor || plan.start_date > anchor.start_date) &&
        plan.days.some((day) => !day.is_rest && day.completed_at === null),
    );
  return (
    next?.id ??
    [...plans].sort((a, b) => time(b.published_at) - time(a.published_at) || createdOrder(b, a))[0]
      ?.id ??
    null
  );
}

export function handoffStatus(
  plan: HandoffPlan,
  current: HandoffPlan | undefined,
): 'current' | 'upcoming' | 'past' {
  if (plan.id === current?.id) return 'current';
  return current &&
    handoffOrder(plan, current) > 0 &&
    plan.days.some((day) => !day.is_rest && day.completed_at === null)
    ? 'upcoming'
    : 'past';
}

export function visibleToLegacyStudent(
  plan: HandoffPlan,
  current: HandoffPlan | undefined,
): boolean {
  return (
    !current ||
    plan.id === current.id ||
    handoffOrder(plan, current) <= 0 ||
    plan.latest_record_at !== null
  );
}
