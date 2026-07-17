import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import type { Logger } from '../logger';

const DIGEST_EVENT_TYPE = 'coach_daily_digest';
const DIGEST_TITLE = '昨日训练摘要';

export interface DailyDigestCounts {
  session_completed: number;
  session_partial: number;
  missed_training: number;
  pr_e1rm: number;
}

type DailyDigestLogger = Pick<Logger, 'info'>;

function emptyCounts(): DailyDigestCounts {
  return {
    session_completed: 0,
    session_partial: 0,
    missed_training: 0,
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
    counts.pr_e1rm > 0 ? `${String(counts.pr_e1rm)} 破 PR` : null,
  ].filter((segment): segment is string => segment !== null);
  return segments.length === 0 ? null : `昨天：${segments.join(' · ')}`;
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

  const [events, signals] = await Promise.all([
    db
      .selectFrom('student_events')
      .select(['student_id', 'coach_id', 'event_type', 'dedup_key'])
      .where('session_date', '=', gymDay)
      .execute(),
    db
      .selectFrom('student_signals')
      .select(['id', 'student_id', 'coach_id', 'payload'])
      .where('coach_id', 'in', coachIds)
      .where('signal_type', '=', 'missed_training')
      .where('status', '=', 'open')
      .execute(),
  ]);

  // Dedup set is ownership-blind: a partial superseded by ANY completed event
  // for the same student and day must not count, even when the completed
  // event's coach attribution is null or belongs to a different coach.
  const completedSuffixes = new Set(
    events.flatMap((event) => {
      if (event.event_type !== 'session_completed') return [];
      const suffix = eventSuffix(event.dedup_key, 'session_completed');
      return suffix === null ? [] : [suffix];
    }),
  );
  const countsByCoach = new Map(coachIds.map((coachId) => [coachId, emptyCounts()]));

  for (const event of events) {
    if (event.coach_id === null || !countsByCoach.has(event.coach_id)) {
      continue;
    }
    const counts = countsByCoach.get(event.coach_id);
    if (counts === undefined) continue;
    if (event.event_type === 'session_completed') counts.session_completed += 1;
    if (event.event_type === 'pr_e1rm') counts.pr_e1rm += 1;
    if (event.event_type === 'session_partial') {
      const suffix = eventSuffix(event.dedup_key, 'session_partial');
      if (suffix !== null && !completedSuffixes.has(suffix)) counts.session_partial += 1;
    }
  }

  const missedStudentsByCoach = new Map<string, Set<string>>();
  for (const signal of signals) {
    if (!includesGymDay(signal.payload, gymDay)) continue;
    const students = missedStudentsByCoach.get(signal.coach_id) ?? new Set<string>();
    students.add(signal.student_id);
    missedStudentsByCoach.set(signal.coach_id, students);
  }
  for (const [coachId, students] of missedStudentsByCoach) {
    const counts = countsByCoach.get(coachId);
    if (counts !== undefined) counts.missed_training = students.size;
  }

  let inserted = 0;
  for (const [coachId, counts] of countsByCoach) {
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
