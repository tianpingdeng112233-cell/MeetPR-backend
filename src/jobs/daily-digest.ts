import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { normalizeDateOnly, trainingDay, utcDate, utcDateOnly } from '../utils/date';
import { DEFAULT_TIME_ZONE } from '../utils/timezone';

const DIGEST_EVENT_TYPE = 'coach_daily_digest';
const DIGEST_TITLE = '昨日训练摘要';
const DIGEST_TITLE_EN = "Yesterday's training recap";

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

function missedGymDays(payload: Record<string, unknown> | string): string[] {
  const decoded = parsePayload(payload);
  return Array.isArray(decoded?.missed_dates)
    ? decoded.missed_dates.filter((value): value is string => typeof value === 'string')
    : [];
}

function eventSuffix(
  dedupKey: string,
  eventType: 'session_completed' | 'session_partial',
): string | null {
  const prefix = `${eventType}:`;
  return dedupKey.startsWith(prefix) ? dedupKey.slice(prefix.length) : null;
}

function shiftCalendarDay(value: string, days: number): string {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateOnly(date);
}

function latestClosedGymDay(now: Date, timezone: string): string {
  return shiftCalendarDay(trainingDay(now, timezone), -1);
}

function gymDaysAfter(startExclusive: string, endInclusive: string): string[] {
  const cursor = utcDate(startExclusive);
  const end = utcDate(endInclusive);
  const days: string[] = [];
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    days.push(utcDateOnly(cursor));
  }
  return days;
}

function bondKey(coachId: string, studentId: string): string {
  return `${coachId}:${studentId}`;
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

export function dailyDigestBody(
  counts: DailyDigestCounts,
  locale: 'zh' | 'en' = 'zh',
): string | null {
  const segments =
    locale === 'en'
      ? [
          counts.session_completed > 0 ? `${String(counts.session_completed)} done` : null,
          counts.session_partial > 0 ? `${String(counts.session_partial)} partial` : null,
          counts.missed_training > 0 ? `${String(counts.missed_training)} missed` : null,
          counts.pr_e1rm > 0
            ? `${String(counts.pr_e1rm)} ${counts.pr_e1rm === 1 ? 'PR' : 'PRs'}`
            : null,
        ].filter((segment): segment is string => segment !== null)
      : [
          counts.session_completed > 0 ? `${String(counts.session_completed)} 练完` : null,
          counts.session_partial > 0 ? `${String(counts.session_partial)} 部分完成` : null,
          counts.missed_training > 0 ? `${String(counts.missed_training)} 缺练` : null,
          counts.pr_e1rm > 0 ? `${String(counts.pr_e1rm)} 破 PR` : null,
        ].filter((segment): segment is string => segment !== null);
  if (segments.length === 0) return null;
  return locale === 'en' ? `Yesterday: ${segments.join(' · ')}` : `昨天：${segments.join(' · ')}`;
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
  timezone = DEFAULT_TIME_ZONE,
  failedStudentIds: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
  const acceptedBonds = (
    await db
      .selectFrom('bind_requests as br')
      .innerJoin('users as coach', 'coach.id', 'br.coach_id')
      .innerJoin('users as student', 'student.id', 'br.student_id')
      .select([
        'br.coach_id',
        'br.student_id',
        'student.timezone as student_timezone',
        'coach.phone as coach_phone',
      ])
      .where('br.status', '=', 'accepted')
      .where('coach.role', '=', 'coach')
      .where('coach.timezone', '=', timezone)
      .execute()
  ).filter((bond) => !failedStudentIds.has(bond.student_id));
  const coachIds = [...new Set(acceptedBonds.map((bond) => bond.coach_id))];
  const coachLocaleById = new Map<string, 'zh' | 'en'>(
    acceptedBonds.map((bond) => [bond.coach_id, bond.coach_phone === null ? 'en' : 'zh']),
  );
  if (coachIds.length === 0) {
    logger.info({ gymDay, inserted: 0 }, 'coach_daily_digest_completed');
    return;
  }

  const studentIds = [...new Set(acceptedBonds.map((bond) => bond.student_id))];
  const watermarks = await db
    .selectFrom('digest_watermarks')
    .select(['coach_id', 'student_id', 'last_gym_day'])
    .where('coach_id', 'in', coachIds)
    .where('student_id', 'in', studentIds)
    .execute();
  const watermarkByBond = new Map(
    watermarks.map((watermark) => [
      bondKey(watermark.coach_id, watermark.student_id),
      normalizeDateOnly(watermark.last_gym_day),
    ]),
  );

  const targetDaysByBond = new Map<string, Set<string>>();
  const latestDayByBond = new Map<string, string>();
  const targetDaysByStudent = new Map<string, Set<string>>();
  for (const bond of acceptedBonds) {
    const key = bondKey(bond.coach_id, bond.student_id);
    const latestDay = latestClosedGymDay(now, bond.student_timezone);
    const watermark = watermarkByBond.get(key) ?? shiftCalendarDay(latestDay, -1);
    const targetDays = new Set(gymDaysAfter(watermark, latestDay));
    if (targetDays.size === 0) continue;
    targetDaysByBond.set(key, targetDays);
    latestDayByBond.set(key, latestDay);
    const days = targetDaysByStudent.get(bond.student_id) ?? new Set<string>();
    for (const targetDay of targetDays) days.add(targetDay);
    targetDaysByStudent.set(bond.student_id, days);
  }
  const targetDays = [...new Set([...targetDaysByStudent.values()].flatMap((days) => [...days]))];
  if (targetDays.length === 0) {
    logger.info({ gymDay, inserted: 0 }, 'coach_daily_digest_completed');
    return;
  }

  const [events, signals] = await Promise.all([
    db
      .selectFrom('student_events')
      .select(['student_id', 'coach_id', 'event_type', 'session_date', 'dedup_key'])
      .where('student_id', 'in', studentIds)
      .where('session_date', 'in', targetDays)
      .execute(),
    db
      .selectFrom('student_signals')
      .select(['id', 'student_id', 'coach_id', 'payload'])
      .where('coach_id', 'in', coachIds)
      .where('student_id', 'in', studentIds)
      .where('signal_type', '=', 'missed_training')
      .where('status', '=', 'open')
      .execute(),
  ]);

  // Dedup set is ownership-blind: a partial superseded by ANY completed event
  // for the same student and day must not count, even when the completed
  // event's coach attribution is null or belongs to a different coach.
  const completedSuffixes = new Set(
    events.flatMap((event) => {
      const eventDay = normalizeDateOnly(event.session_date);
      if (!targetDaysByStudent.get(event.student_id)?.has(eventDay)) return [];
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
    const eventDay = normalizeDateOnly(event.session_date);
    if (!targetDaysByBond.get(bondKey(event.coach_id, event.student_id))?.has(eventDay)) continue;
    const counts = countsByCoach.get(event.coach_id);
    if (counts === undefined) continue;
    if (event.event_type === 'session_completed') counts.session_completed += 1;
    if (event.event_type === 'pr_e1rm') counts.pr_e1rm += 1;
    if (event.event_type === 'session_partial') {
      const suffix = eventSuffix(event.dedup_key, 'session_partial');
      if (suffix !== null && !completedSuffixes.has(suffix)) counts.session_partial += 1;
    }
  }

  const missedCountsByCoach = new Map<string, number>();
  for (const signal of signals) {
    const targetDaysForBond = targetDaysByBond.get(bondKey(signal.coach_id, signal.student_id));
    if (targetDaysForBond === undefined) continue;
    const count = missedGymDays(signal.payload).filter((day) => targetDaysForBond.has(day)).length;
    if (count === 0) continue;
    missedCountsByCoach.set(
      signal.coach_id,
      (missedCountsByCoach.get(signal.coach_id) ?? 0) + count,
    );
  }
  for (const [coachId, missedCount] of missedCountsByCoach) {
    const counts = countsByCoach.get(coachId);
    if (counts !== undefined) counts.missed_training = missedCount;
  }

  let inserted = 0;
  for (const [coachId, counts] of countsByCoach) {
    const watermarkValues = acceptedBonds.flatMap((bond) => {
      if (bond.coach_id !== coachId) return [];
      const lastGymDay = latestDayByBond.get(bondKey(coachId, bond.student_id));
      return lastGymDay === undefined
        ? []
        : [
            {
              coach_id: coachId,
              student_id: bond.student_id,
              last_gym_day: lastGymDay,
              updated_at: now,
            },
          ];
    });
    if (watermarkValues.length === 0) continue;
    const locale = coachLocaleById.get(coachId) ?? 'zh';
    const body = dailyDigestBody(counts, locale);
    const didInsert = await db.transaction().execute(async (trx) => {
      let outboxInserted = false;
      if (body !== null) {
        const aggregateId = deriveDailyDigestAggregateId(coachId, gymDay);
        const existingOutbox = await trx
          .selectFrom('notification_outbox')
          .select('id')
          .where('event_type', '=', DIGEST_EVENT_TYPE)
          .where('aggregate_id', '=', aggregateId)
          .where('recipient_id', '=', coachId)
          .executeTakeFirst();
        if (existingOutbox === undefined) {
          const result = await trx
            .insertInto('notification_outbox')
            .values({
              event_type: DIGEST_EVENT_TYPE,
              aggregate_id: aggregateId,
              recipient_id: coachId,
              payload: JSON.stringify({
                aps: {
                  alert: { title: locale === 'en' ? DIGEST_TITLE_EN : DIGEST_TITLE, body },
                },
                counts,
                gym_day: gymDay,
              }),
              created_at: now,
            })
            .onConflict((oc) =>
              oc.columns(['event_type', 'aggregate_id', 'recipient_id']).doNothing(),
            )
            .returning('id')
            .executeTakeFirst();
          outboxInserted = result !== undefined;
        }
      }
      // A later hourly scan can see a west-of-coach student close another day
      // after this coach-day's digest was already sent. The idempotency conflict
      // must leave that student's watermark untouched so the next coach-day can
      // include it. A zero-count window is safe to consume without an outbox.
      if (body === null || outboxInserted) {
        await trx
          .insertInto('digest_watermarks')
          .values(watermarkValues)
          .onConflict((oc) =>
            oc.columns(['coach_id', 'student_id']).doUpdateSet({
              last_gym_day: (eb) => eb.ref('excluded.last_gym_day'),
              updated_at: (eb) => eb.ref('excluded.updated_at'),
            }),
          )
          .execute();
      }
      return outboxInserted;
    });
    if (didInsert) inserted += 1;
  }

  logger.info({ gymDay, inserted }, 'coach_daily_digest_completed');
}
