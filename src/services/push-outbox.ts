import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import type { Logger } from '../logger';

export type PerEventPushType =
  | 'chat_message'
  | 'missed_training'
  | 'pr_congrats'
  | 'video_pending'
  | 'bind_request'
  | 'plan_shift'
  | 'plan_updated';

interface PushOutboxValues {
  aggregateId: string;
  recipientId: string;
  payload: Record<string, unknown>;
}

type PushOutboxLogger = Pick<Logger, 'warn'>;

/**
 * Runs only after the caller's business transaction commits. Every lookup and
 * the outbox insert are deliberately fail-open: push availability must never
 * change the outcome of the business action that produced it.
 */
export async function tryEnqueuePushOutbox(
  db: Kysely<Database>,
  logger: PushOutboxLogger,
  eventType: PerEventPushType,
  values: () => Promise<PushOutboxValues> | PushOutboxValues,
): Promise<void> {
  try {
    const resolved = await values();
    await db
      .insertInto('notification_outbox')
      .values({
        event_type: eventType,
        aggregate_id: resolved.aggregateId,
        recipient_id: resolved.recipientId,
        payload: JSON.stringify(resolved.payload),
      })
      .onConflict((oc) => oc.columns(['event_type', 'aggregate_id', 'recipient_id']).doNothing())
      .execute();
  } catch (err) {
    logger.warn({ err, eventType }, 'push_outbox_enqueue_failed');
  }
}

export async function pushDisplayName(db: Kysely<Database>, userId: string): Promise<string> {
  const profile = await db
    .selectFrom('users as u')
    .leftJoin('coach_profiles as cp', 'cp.user_id', 'u.id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .select(['u.role', 'cp.display_name as coach_name', 'sp.display_name as student_name'])
    .where('u.id', '=', userId)
    .executeTakeFirstOrThrow();
  return profile.coach_name ?? profile.student_name ?? (profile.role === 'coach' ? '教练' : '学员');
}
