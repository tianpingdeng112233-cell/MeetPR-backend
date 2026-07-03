import type { Insertable, Kysely } from 'kysely';

import type { AnalyticsFeedbackTable, Database, EventsTable } from '../db/types';

/**
 * Single-batch insert with ON CONFLICT(event_id) DO NOTHING: an at-least-once
 * client retry (lost 204 ack / killed flush) dedups to exactly-once storage.
 * Callers MUST await this before responding — a throw here becomes a 5xx so the
 * client keeps the batch and retries (SPEC CRITICAL #1/#2).
 */
export async function insertEvents(
  db: Kysely<Database>,
  rows: Insertable<EventsTable>[],
): Promise<void> {
  await db
    .insertInto('events')
    .values(rows)
    .onConflict((oc) => oc.column('event_id').doNothing())
    .execute();
}

/** §4b free-text path — same idempotency + await-before-respond contract. */
export async function insertFeedback(
  db: Kysely<Database>,
  row: Insertable<AnalyticsFeedbackTable>,
): Promise<void> {
  await db
    .insertInto('analytics_feedback')
    .values(row)
    .onConflict((oc) => oc.column('event_id').doNothing())
    .execute();
}
