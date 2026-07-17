import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../db/types';
import { PUSH_POLICY } from '../domain/push-policy';
import type { Logger } from '../logger';
import type { ApnsClient, ApnsResult } from '../services/apns';

const PUSH_EVENT_TYPE = 'coach_daily_digest';

type PushConsumerLogger = Pick<Logger, 'warn'>;
type PushTransaction = Transaction<Database>;

function payloadValue(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function apnsFailure(result: ApnsResult): string {
  return `apns_${String(result.status)}:${result.reason ?? 'unknown'}`;
}

function shouldDeleteToken(result: ApnsResult): boolean {
  return (
    result.status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'Unregistered'
  );
}

async function markFailedAttempt(
  trx: PushTransaction,
  outboxId: string,
  previousAttempts: number,
  lastError: string,
  logger: PushConsumerLogger,
): Promise<void> {
  const attemptCount = previousAttempts + 1;
  const status = attemptCount >= PUSH_POLICY.maxAttempts ? 'failed' : 'pending';
  await trx
    .updateTable('notification_outbox')
    .set({ attempt_count: attemptCount, last_error: lastError, status })
    .where('id', '=', outboxId)
    .where('status', '=', 'pending')
    .execute();
  logger.warn({ outboxId, attemptCount, status, lastError }, 'push_delivery_attempt_failed');
}

/**
 * The pending-row lock, exported so tests can pin its compiled shape. SKIP
 * LOCKED lets concurrent instances shard the batch instead of queueing on the
 * same rows; pg-mem cannot execute the clause, so the test harness strips it
 * at the adapter boundary while a compile assertion keeps production honest.
 */
export function pendingDigestRowQuery(db: Kysely<Database> | PushTransaction, outboxId: string) {
  return db
    .selectFrom('notification_outbox')
    .select(['id', 'recipient_id', 'payload', 'attempt_count'])
    .where('id', '=', outboxId)
    .where('event_type', '=', PUSH_EVENT_TYPE)
    .where('status', '=', 'pending')
    .forUpdate()
    .skipLocked();
}

async function consumeRow(
  db: Kysely<Database>,
  outboxId: string,
  apnsClient: ApnsClient,
  now: Date,
  logger: PushConsumerLogger,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const outbox = await pendingDigestRowQuery(trx, outboxId).executeTakeFirst();
    if (outbox === undefined) return;

    const tokens = await trx
      .selectFrom('device_tokens')
      .select(['id', 'token'])
      .where('user_id', '=', outbox.recipient_id)
      .orderBy('created_at', 'asc')
      .execute();
    if (tokens.length === 0) {
      await markFailedAttempt(trx, outbox.id, outbox.attempt_count, 'no_device_tokens', logger);
      return;
    }

    // Per-token outcome classification. A terminally-dead token (410 /
    // BadDeviceToken / Unregistered) is recycled and must NOT fail the row:
    // retrying cannot ever deliver to it. Only transient failures retry the
    // row — re-sends to tokens that already succeeded carry the outbox id as
    // apns-collapse-id, so the device collapses the duplicate.
    let successes = 0;
    const transientFailures: string[] = [];
    for (const device of tokens) {
      try {
        const result = await apnsClient.send(device.token, payloadValue(outbox.payload), {
          collapseId: outbox.id,
        });
        if (result.ok) {
          successes += 1;
        } else if (shouldDeleteToken(result)) {
          await trx.deleteFrom('device_tokens').where('id', '=', device.id).execute();
        } else {
          transientFailures.push(apnsFailure(result));
        }
      } catch (err) {
        transientFailures.push(`apns_error:${errorMessage(err)}`);
      }
    }

    if (transientFailures.length > 0) {
      await markFailedAttempt(
        trx,
        outbox.id,
        outbox.attempt_count,
        transientFailures.join('; '),
        logger,
      );
      return;
    }
    if (successes === 0) {
      // Every token was terminally recycled: retrying cannot deliver to
      // anyone, so terminate the row instead of spinning to maxAttempts (a
      // token registered later is served by the NEXT day's digest, not this
      // stale one).
      await trx
        .updateTable('notification_outbox')
        .set({
          status: 'failed',
          attempt_count: outbox.attempt_count + 1,
          last_error: 'all_tokens_unregistered',
        })
        .where('id', '=', outbox.id)
        .where('status', '=', 'pending')
        .execute();
      logger.warn({ outboxId: outbox.id }, 'push_delivery_no_registered_tokens');
      return;
    }

    await trx
      .updateTable('notification_outbox')
      .set({ status: 'delivered', delivered_at: now, last_error: null })
      .where('id', '=', outbox.id)
      .where('status', '=', 'pending')
      .execute();
  });
}

export async function consumePushOutbox(
  db: Kysely<Database>,
  apnsClient: ApnsClient,
  now: Date,
  logger: PushConsumerLogger,
): Promise<void> {
  const candidates = await db
    .selectFrom('notification_outbox')
    .select('id')
    .where('event_type', '=', PUSH_EVENT_TYPE)
    .where('status', '=', 'pending')
    .orderBy('created_at', 'asc')
    .limit(PUSH_POLICY.consumerBatchSize)
    .execute();

  for (const candidate of candidates) {
    await consumeRow(db, candidate.id, apnsClient, now, logger);
  }
}
