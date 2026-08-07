import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import type { Database, SessionStatus, StudentEventType } from '../db/types';
import { SIGNAL_POLICY } from '../domain/signal-policy';
import type { Logger } from '../logger';
import { pushDisplayName, tryEnqueuePushOutbox } from '../services/push-outbox';
import { normalizeDateOnly, shanghaiTrainingDay } from '../utils/date';
import { detectSetLogPr } from './pr-detection';
import { sessionProgress } from './session-progress';

type DbExecutor = Kysely<Database> | Transaction<Database>;

interface ActivityPushOptions {
  enabled: boolean;
  logger: Pick<Logger, 'warn'>;
}

const SessionEventPayloadSchema = z.object({
  session_id: z.string().uuid(),
  plan_day_ids: z.array(z.string().uuid()),
  duration_seconds: z.number().int().nonnegative(),
  sets_logged: z.number().int().nonnegative(),
});

type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;

function durationSeconds(startedAt: Date, lastSetAt: Date): number {
  return Math.max(0, Math.floor((lastSetAt.getTime() - startedAt.getTime()) / 1000));
}

async function acceptedCoachId(db: DbExecutor, studentId: string): Promise<string | null> {
  const bonds = await db
    .selectFrom('bind_requests')
    .select(['coach_id', 'responded_at'])
    .where('student_id', '=', studentId)
    .where('status', '=', 'accepted')
    .execute();
  // Deterministic in JS (SQL NULL ordering differs by dialect): most recently
  // accepted bond first, NULL responded_at last, coach_id as a stable tiebreak.
  bonds.sort((a, b) => {
    const aTime = a.responded_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bTime = b.responded_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) return bTime - aTime;
    return a.coach_id.localeCompare(b.coach_id);
  });
  return bonds[0]?.coach_id ?? null;
}

/**
 * Attribution order: the coach who owns the touched plan(s) wins — with more
 * than one accepted bond, the session belongs to the plan's author, not an
 * arbitrary bond. Bond fallback covers pure-adhoc days.
 */
export async function resolveEventCoachId(
  db: DbExecutor,
  studentId: string,
  planCoachId: string | null,
): Promise<string | null> {
  return planCoachId ?? (await acceptedCoachId(db, studentId));
}

async function writeSessionEvent(
  db: DbExecutor,
  input: {
    eventType: Extract<StudentEventType, 'session_completed' | 'session_partial'>;
    studentId: string;
    coachId: string | null;
    sessionDate: string;
    occurredAt: Date;
    payload: SessionEventPayload;
  },
): Promise<void> {
  const payload = SessionEventPayloadSchema.parse(input.payload);
  const coachId = input.coachId;

  await db
    .insertInto('student_events')
    .values({
      student_id: input.studentId,
      coach_id: coachId,
      event_type: input.eventType,
      session_date: input.sessionDate,
      occurred_at: input.occurredAt,
      payload: JSON.stringify(payload),
      dedup_key: `${input.eventType}:${input.studentId}:${input.sessionDate}`,
    })
    .onConflict((oc) => oc.column('dedup_key').doNothing())
    .execute();
}

/**
 * Recompute the triggering set's whole gym-day session from set_logs. The
 * set-log identity is used to recover its stored logged_date, including the
 * old-client upsert path which deliberately preserves a historical date.
 */
export async function recordSetLogActivity(
  db: Kysely<Database>,
  studentId: string,
  setLogId: string,
  now: Date = new Date(),
  push?: ActivityPushOptions,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const triggeringLog = await trx
      .selectFrom('set_logs')
      .select(['logged_date', 'logged_at', 'assumed'])
      .where('id', '=', setLogId)
      .where('student_id', '=', studentId)
      .executeTakeFirst();
    if (!triggeringLog || triggeringLog.assumed) return;

    const sessionDate = normalizeDateOnly(triggeringLog.logged_date);
    const triggerIsTimed = shanghaiTrainingDay(triggeringLog.logged_at) === sessionDate;

    // Seed the row before locking it: concurrent first-set hooks then
    // serialize on the row lock instead of racing the UNIQUE constraint. The
    // triggering log's own timestamp is enough — the post-lock recompute
    // merges the full picture.
    if (triggerIsTimed) {
      await trx
        .insertInto('training_sessions')
        .values({
          student_id: studentId,
          session_date: sessionDate,
          status: 'in_progress',
          started_at: triggeringLog.logged_at,
          last_set_at: triggeringLog.logged_at,
        })
        .onConflict((oc) => oc.columns(['student_id', 'session_date']).doNothing())
        .execute();
    }

    const existing = await trx
      .selectFrom('training_sessions')
      .selectAll()
      .where('student_id', '=', studentId)
      .where('session_date', '=', sessionDate)
      .forUpdate()
      .executeTakeFirst();
    // An out-of-window backfill/edit may affect completion counts, but never
    // the established clock. With no prior clock and no in-window logs there
    // is no valid started_at from which a session row could be created.
    if (!existing) return;

    // Everything below reads AFTER the lock so a slower concurrent hook cannot
    // overwrite the session with a stale snapshot of the day's logs.
    const logs = await trx
      .selectFrom('set_logs')
      .select(['plan_exercise_id', 'completed', 'failed', 'logged_at'])
      .where('student_id', '=', studentId)
      .where('logged_date', '=', sessionDate)
      .where('assumed', '=', false)
      .execute();
    const timedLogs = logs.filter((log) => shanghaiTrainingDay(log.logged_at) === sessionDate);
    const timestamps = timedLogs.map((log) => log.logged_at.getTime());
    const progress = await sessionProgress(trx, logs);
    // The upsert overwrites logged_at in place, so the session row is the only
    // record of the original submission times. Merge monotonically: started_at
    // only ever moves earlier, last_set_at only ever moves later — an in-window
    // edit is a fresh submission (extends the clock) but must not erase the
    // session start.
    const windowMin = timestamps.length > 0 ? Math.min(...timestamps) : Number.POSITIVE_INFINITY;
    const windowMax = timestamps.length > 0 ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
    const startedAt = new Date(Math.min(existing.started_at.getTime(), windowMin));
    const lastSetAt = new Date(Math.max(existing.last_set_at.getTime(), windowMax));

    let status: SessionStatus;
    if (existing.status === 'completed') {
      status = 'completed';
    } else if (existing.status === 'partial') {
      // Reopen only when sets were added since the archive snapshot; a replay
      // or edit of an already-archived set keeps the archive verdict.
      const reopened =
        existing.archived_sets_logged === null || logs.length > existing.archived_sets_logged;
      status = reopened ? (progress.plannedComplete ? 'completed' : 'in_progress') : 'partial';
    } else {
      status = progress.plannedComplete ? 'completed' : 'in_progress';
    }

    const completedAt = existing.completed_at ?? (status === 'completed' ? now : null);
    const session = await trx
      .updateTable('training_sessions')
      .set({
        status,
        started_at: startedAt,
        last_set_at: lastSetAt,
        completed_at: completedAt,
        plan_day_ids: progress.planDayIds,
        archived_sets_logged:
          status === 'in_progress'
            ? null
            : status === 'completed'
              ? logs.length
              : existing.archived_sets_logged,
        updated_at: now,
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (status === 'completed' && existing.status !== 'completed') {
      await writeSessionEvent(trx, {
        eventType: 'session_completed',
        studentId,
        coachId: await resolveEventCoachId(trx, studentId, progress.planCoachId),
        sessionDate,
        occurredAt: completedAt ?? now,
        payload: {
          session_id: session.id,
          plan_day_ids: progress.planDayIds,
          duration_seconds: durationSeconds(startedAt, lastSetAt),
          sets_logged: logs.length,
        },
      });
    }
  });

  // PR detection runs in its own transaction AFTER the session bookkeeping has
  // committed: a PR-side failure must never roll back the session state
  // machine and its fact events (the route hook only warns, so that loss would
  // be permanent for a day with no further sets). Event + signal still commit
  // atomically with each other inside this transaction.
  const prPush = await db
    .transaction()
    .execute((trx) => detectSetLogPr(trx, studentId, setLogId, now));
  if (push?.enabled && prPush !== null) {
    await tryEnqueuePushOutbox(db, push.logger, 'pr_congrats', async () => ({
      aggregateId: prPush.signalId,
      recipientId: prPush.coachId,
      payload: {
        student_name: await pushDisplayName(db, prPush.studentId),
        lift_name: prPush.liftName,
        increase_kg: prPush.increaseKg,
        student_id: prPush.studentId,
      },
    }));
  }
}

/** Archive every session whose inactivity is strictly over the policy timeout. */
export async function sweepTimedOutSessions(db: Kysely<Database>, now: Date): Promise<void> {
  const candidates = await db
    .selectFrom('training_sessions')
    .select('id')
    .where('status', '=', 'in_progress')
    .execute();
  const timeoutMs = SIGNAL_POLICY.sessionTimeoutHours * 60 * 60 * 1000;

  for (const candidate of candidates) {
    await db.transaction().execute(async (trx) => {
      const session = await trx
        .selectFrom('training_sessions')
        .selectAll()
        .where('id', '=', candidate.id)
        .where('status', '=', 'in_progress')
        .forUpdate()
        .executeTakeFirst();
      if (!session) return;

      // Full reconcile from live logs: a set whose route hook has not run yet
      // (or failed) must still extend the clock and count toward completion —
      // otherwise the archive snapshot would swallow it and the reopen check
      // could never fire for it.
      const sessionDate = normalizeDateOnly(session.session_date);
      const logs = await trx
        .selectFrom('set_logs')
        .select(['plan_exercise_id', 'completed', 'failed', 'logged_at'])
        .where('student_id', '=', session.student_id)
        .where('logged_date', '=', sessionDate)
        .where('assumed', '=', false)
        .execute();
      const timestamps = logs
        .filter((log) => shanghaiTrainingDay(log.logged_at) === sessionDate)
        .map((log) => log.logged_at.getTime());
      const windowMin = timestamps.length > 0 ? Math.min(...timestamps) : Number.POSITIVE_INFINITY;
      const windowMax = timestamps.length > 0 ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
      const startedAt = new Date(Math.min(session.started_at.getTime(), windowMin));
      const lastSetAt = new Date(Math.max(session.last_set_at.getTime(), windowMax));
      if (now.getTime() - lastSetAt.getTime() <= timeoutMs) return;

      const progress = await sessionProgress(trx, logs);
      const status: Extract<SessionStatus, 'completed' | 'partial'> =
        progress.plannedComplete || progress.planDayIds.length === 0 ? 'completed' : 'partial';
      const archived = await trx
        .updateTable('training_sessions')
        .set({
          status,
          started_at: startedAt,
          last_set_at: lastSetAt,
          completed_at: status === 'completed' ? now : null,
          plan_day_ids: progress.planDayIds,
          archived_sets_logged: logs.length,
          updated_at: now,
        })
        .where('id', '=', session.id)
        .where('status', '=', 'in_progress')
        .returning('id')
        .executeTakeFirst();
      if (!archived) return;

      await writeSessionEvent(trx, {
        eventType: status === 'completed' ? 'session_completed' : 'session_partial',
        studentId: session.student_id,
        coachId: await resolveEventCoachId(trx, session.student_id, progress.planCoachId),
        sessionDate,
        occurredAt: now,
        payload: {
          session_id: session.id,
          plan_day_ids: progress.planDayIds,
          duration_seconds: durationSeconds(startedAt, lastSetAt),
          sets_logged: logs.length,
        },
      });
    });
  }
}
