import type { Logger } from '../logger';

export async function notifyPlanPublished(
  planId: string,
  traineeId: string,
  logger?: Pick<Logger, 'info'>,
): Promise<void> {
  logger?.info({ planId, traineeId }, 'plan_published_notification_stub');
  await Promise.resolve();
}
