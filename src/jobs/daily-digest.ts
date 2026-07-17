import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { Database, StudentEventType } from '../db/types';
import type { Logger } from '../logger';

const DIGEST_EVENT_TYPE = 'coach_daily_digest';
const DIGEST_TITLE = '昨日训练摘要';

export interface DailyDigestCounts {
  session_completed: number;
  session_partial: number;
  missed_training: number;
  weight_failed: number;
  pr_e1rm: number;
}

type DailyDigestLogger = Pick<Logger, 'info'>;

interface DailyDigestEvent {
  student_id: string;
  coach_id: string | null;
  event_type: StudentEventType;
  dedup_key: string;
}

interface DailyDigestSignal {
  student_id: string;
  coach_id: string;
  payload: Record<string, unknown> | string;
}

interface DailyDigestSnapshot {
  events: DailyDigestEvent[];
  signals: DailyDigestSignal[];
}

function emptyCounts(): DailyDigestCounts {
  return {
    session_completed: 0,
    session_partial: 0,
    missed_training: 0,
    weight_failed: 0,
    pr_e1rm: 0,
  };
}

function parsePayload(value: Record<string, unknown> | string): Record<string, unknown> | null {
  if (typeof value !== 'string') return value;
  try {
    const decoded = JSON.parse(value) as unknown;
    return typeof decoded === 'object' && decoded !== null
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function includesGymDay(payload: Record<string, unknown> | string, gymDay: string): boolean {
  const decoded = parsePayload(payload);
  return Array.isArray(decoded?.missed_dates) && decoded.missed_dates.includes(gymDay);
}

function eventSuffix(
  dedupKey: string,
  eventType: 'session_completed' | 'session_partial',
): string | null {
  const prefix = `${eventType}:`;
  return dedupKey.startsWith(prefix) ? dedupKey.slice(prefix.length) : null;
}

// Fixed namespace for daily-digest aggregate ids (RFC 4122 §4.3). Never change
// it: the outbox UNIQUE(event_type, aggregate_id, recipient_id) idempotency
// depends on stable derivation.
const DIGEST_NAMESPACE = '42ae07b9-cb2f-45b4-a781-ed143c9098c7';

/**
 * Standard RFC 4122 UUIDv5: SHA-1(namespace bytes + "<coach UUID>:<YYYY-MM-DD>"),
 * truncated to 128 bits with version/variant bits set.
 */
export function deriveDailyDigestAggregateId(coachId: string, gymDay: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(DIGEST_NAMESPACE.replaceAll('-', ''), 'hex'))
    .update(`${coachId}:${gymDay}`, 'utf8')
    .digest()
    .subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('SHA-1 digest was unexpectedly shorter than 16 bytes');
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function dailyDigestBody(counts: DailyDigestCounts): string | null {
  const segments = [
    counts.session_completed > 0 ? `${String(counts.session_completed)} 练完` : null,
    counts.session_partial > 0 ? `${String(counts.session_partial)} 部分完成` : null,
    counts.missed_training > 0 ? `${String(counts.missed_training)} 缺练` : null,
    counts.weight_failed > 0 ? `${String(counts.weight_failed)} 被压` : null,
    counts.pr_e1rm > 0 ? `${String(counts.pr_e1rm)} 破 PR` : null,
  ].filter((segment): segment is string => segment !== null);
  return segments.length === 0 ? null : `昨天：${segments.join(' · ')}`;
}

async function loadDailyDigestSnapshot(
  db: Kysely<Database>,
  gymDay: string,
  coachIds: readonly string[],
): Promise<DailyDigestSnapshot> {
  const [events, signals] = await Promise.all([
    db
      .selectFrom('student_events')
      .select(['student_id', 'coach_id', 'event_type', 'dedup_key'])
      .where('session_date', '=', gymDay)
      .execute(),
    db
      .selectFrom('student_signals')
      .select(['student_id', 'coach_id', 'payload'])
      .where('coach_id', 'in', coachIds)
      .where('signal_type', '=', 'missed_training')
      .where('status', '=', 'open')
      .execute(),
  ]);
  return { events, signals };
}

/**
 * Read-only single-coach digest aggregation shared by the push job and the
 * cockpit endpoint. Completed-session supersession intentionally reads every
 * coach's events for the gym day: ownership must not let an older partial
 * survive when any completed event exists for the same student/day.
 */
export async function aggregateCoachDigest(
  db: Kysely<Database>,
  coachId: string,
  gymDay: string,
  snapshot?: DailyDigestSnapshot,
): Promise<DailyDigestCounts> {
  const source = snapshot ?? (await loadDailyDigestSnapshot(db, gymDay, [coachId]));

  const completedSuffixes = new Set(
    source.events.flatMap((event) => {
      if (event.event_type !== 'session_completed') return [];
      const suffix = eventSuffix(event.dedup_key, 'session_completed');
      return suffix === null ? [] : [suffix];
    }),
  );
  const counts = emptyCounts();
  for (const event of source.events) {
    if (event.coach_id !== coachId) continue;
    if (event.event_type === 'session_completed') counts.session_completed += 1;
    if (event.event_type === 'pr_e1rm') counts.pr_e1rm += 1;
    if (event.event_type === 'session_partial') {
      const suffix = eventSuffix(event.dedup_key, 'session_partial');
      if (suffix !== null && !completedSuffixes.has(suffix)) counts.session_partial += 1;
    }
  }

  counts.weight_failed = new Set(
    source.events
      .filter((event) => event.coach_id === coachId && event.event_type === 'set_failed')
      .map((event) => event.student_id),
  ).size;

  counts.missed_training = new Set(
    source.signals
      .filter((signal) => signal.coach_id === coachId && includesGymDay(signal.payload, gymDay))
      .map((signal) => signal.student_id),
  ).size;
  return counts;
}

// Demo/DemoStudent hard-ban (CEO plan red line #4): the iOS demo builds are
// fully client-local (in-memory repositories, no backend accounts, no device
// tokens), so there is nothing to exclude server-side — and reading the 0029
// analytics `events` table to drive business behavior would itself cross the
// business-tables-only red line. The enforcement point is the iOS W1 card:
// Demo builds must never register a device token.
export async function runDailyDigest(
  db: Kysely<Database>,
  gymDay: string,
  now: Date,
  logger: DailyDigestLogger,
): Promise<void> {
  const acceptedBonds = await db
    .selectFrom('bind_requests as br')
    .innerJoin('users as coach', 'coach.id', 'br.coach_id')
    .select(['br.coach_id', 'br.student_id'])
    .where('br.status', '=', 'accepted')
    .where('coach.role', '=', 'coach')
    .execute();
  const coachIds = [...new Set(acceptedBonds.map((bond) => bond.coach_id))];
  if (coachIds.length === 0) {
    logger.info({ gymDay, inserted: 0 }, 'coach_daily_digest_completed');
    return;
  }

  let inserted = 0;
  const snapshot = await loadDailyDigestSnapshot(db, gymDay, coachIds);
  for (const coachId of coachIds) {
    const counts = await aggregateCoachDigest(db, coachId, gymDay, snapshot);
    const body = dailyDigestBody(counts);
    if (body === null) continue;
    const result = await db
      .insertInto('notification_outbox')
      .values({
        event_type: DIGEST_EVENT_TYPE,
        aggregate_id: deriveDailyDigestAggregateId(coachId, gymDay),
        recipient_id: coachId,
        payload: JSON.stringify({
          aps: { alert: { title: DIGEST_TITLE, body } },
          counts,
          gym_day: gymDay,
        }),
        created_at: now,
      })
      .onConflict((oc) => oc.columns(['event_type', 'aggregate_id', 'recipient_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (result !== undefined) inserted += 1;
  }

  logger.info({ gymDay, inserted }, 'coach_daily_digest_completed');
}
