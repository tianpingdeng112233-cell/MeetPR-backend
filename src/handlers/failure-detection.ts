import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { SIGNAL_POLICY } from '../domain/signal-policy';
import { normalizeDateOnly } from '../utils/date';
import { resolveEventCoachId } from './activity-ledger';

type DbExecutor = Kysely<Database> | Transaction<Database>;

const DAY_MS = 24 * 60 * 60 * 1000;

const SetFailedEventPayloadSchema = z.object({
  set_log_id: z.string().uuid(),
  exercise_id: z.string().uuid(),
  weight_kg: z.number().nonnegative().finite(),
  reps: z.number().int().nonnegative(),
  set_index: z.number().int().nonnegative(),
  logged_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const WeightFailedSignalPayloadSchema = z.object({
  gym_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  failed_count: z.number().int().positive(),
});

type WeightFailedSignalPayload = z.infer<typeof WeightFailedSignalPayloadSchema>;

function parseSignalPayload(
  value: Record<string, unknown> | string,
): WeightFailedSignalPayload | null {
  try {
    const decoded = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    const parsed = WeightFailedSignalPayloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function displayWeight(weightKg: number): string {
  return String(weightKg);
}

// No per-set ordinal in the copy: historical set_index bases are mixed
// (0-based import path vs 1-based client examples, see migration 0041 notes),
// so "第 N 组" cannot be derived honestly. failed_count is our own counter and
// is reliable.
function failureReason(exerciseName: string, weightKg: number, failedCount: number): string {
  const base = `${exerciseName} ${displayWeight(weightKg)}kg 未完成`;
  return failedCount > 1 ? `${base}（今日第 ${String(failedCount)} 次）` : base;
}

async function upsertOpenWeightFailed(
  db: DbExecutor,
  input: {
    studentId: string;
    coachId: string;
    gymDay: string;
    exerciseName: string;
    weightKg: number;
    openedAt: Date;
  },
): Promise<void> {
  // LOCK CONTRACT: every writer of open student_signals rows takes the
  // student-row lock before select-then-update/insert. The partial unique
  // index cannot be targeted by ON CONFLICT under pg-mem, and a caught 23505
  // would abort the real PostgreSQL transaction. See pr-detection.ts.
  await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', input.studentId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  const existing = await db
    .selectFrom('student_signals')
    .select(['id', 'payload'])
    .where('student_id', '=', input.studentId)
    .where('coach_id', '=', input.coachId)
    .where('signal_type', '=', 'weight_failed')
    .where('status', '=', 'open')
    .forUpdate()
    .executeTakeFirst();
  const existingPayload = existing === undefined ? null : parseSignalPayload(existing.payload);
  const expiresAt = new Date(input.openedAt.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS);

  if (existing !== undefined) {
    // Same day: bump the counter. A NEWER day means a stale open row that
    // never left the board — the partial unique index allows only one open row
    // per pair, so renew it in place (same philosophy as the missed-training
    // winner switch; inserting would 23505 and roll back the whole transaction
    // including the set_failed fact event). An OLDER day (backdated log) keeps
    // the fact event but must never regress the signal — monotonic gym-day
    // watermark, same as everywhere else in the ledger.
    if (existingPayload !== null && input.gymDay < existingPayload.gym_day) return;
    const failedCount =
      existingPayload?.gym_day === input.gymDay ? existingPayload.failed_count + 1 : 1;
    await db
      .updateTable('student_signals')
      .set({
        reason: failureReason(input.exerciseName, input.weightKg, failedCount),
        payload: JSON.stringify({
          gym_day: input.gymDay,
          failed_count: failedCount,
        } satisfies WeightFailedSignalPayload),
        ...(existingPayload?.gym_day === input.gymDay ? {} : { opened_at: input.openedAt }),
        expires_at: expiresAt,
        updated_at: input.openedAt,
      })
      .where('id', '=', existing.id)
      .where('status', '=', 'open')
      .execute();
    return;
  }

  await db
    .insertInto('student_signals')
    .values({
      student_id: input.studentId,
      coach_id: input.coachId,
      signal_type: 'weight_failed',
      severity: 'yellow',
      status: 'open',
      reason: failureReason(input.exerciseName, input.weightKg, 1),
      payload: JSON.stringify({
        gym_day: input.gymDay,
        failed_count: 1,
      } satisfies WeightFailedSignalPayload),
      opened_at: input.openedAt,
      expires_at: expiresAt,
      updated_at: input.openedAt,
    })
    .execute();
}

/** Record one main-lift failed set and its same-day coach signal atomically. */
export async function detectSetLogFailure(
  db: DbExecutor,
  studentId: string,
  setLogId: string,
  now: Date = new Date(),
): Promise<void> {
  const trigger = await db
    .selectFrom('set_logs as sl')
    .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .innerJoin('exercises as e', 'e.id', 'sl.exercise_id')
    .select([
      'sl.exercise_id as exercise_id',
      'sl.weight_kg as weight_kg',
      'sl.reps as reps',
      'sl.set_index as set_index',
      'sl.failed as failed',
      'sl.assumed as assumed',
      'sl.logged_date as logged_date',
      'sl.logged_at as logged_at',
      'pe.is_main_lift as is_main_lift',
      'p.coach_id as plan_coach_id',
      'e.name as exercise_name',
    ])
    .where('sl.id', '=', setLogId)
    .where('sl.student_id', '=', studentId)
    .executeTakeFirst();
  if (!trigger || !trigger.failed || trigger.assumed || !trigger.is_main_lift) return;

  const payload = SetFailedEventPayloadSchema.parse({
    set_log_id: setLogId,
    exercise_id: trigger.exercise_id,
    weight_kg: Number(trigger.weight_kg),
    reps: trigger.reps,
    set_index: trigger.set_index,
    logged_date: normalizeDateOnly(trigger.logged_date),
  });
  const dedupKey = `fail:${studentId}:${setLogId}`;
  // Besides avoiding needless work on ordinary replays, this makes pg-mem
  // match PostgreSQL: pg-mem incorrectly returns a row from DO NOTHING.
  const replayed = await db
    .selectFrom('student_events')
    .select('id')
    .where('dedup_key', '=', dedupKey)
    .executeTakeFirst();
  if (replayed) return;

  const coachId = await resolveEventCoachId(db, studentId, trigger.plan_coach_id);
  const insertedEvent = await db
    .insertInto('student_events')
    .values({
      student_id: studentId,
      coach_id: coachId,
      event_type: 'set_failed',
      session_date: payload.logged_date,
      occurred_at: trigger.logged_at,
      payload: JSON.stringify(payload),
      dedup_key: dedupKey,
    })
    .onConflict((oc) => oc.column('dedup_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!insertedEvent || coachId === null) return;

  await upsertOpenWeightFailed(db, {
    studentId,
    coachId,
    gymDay: payload.logged_date,
    exerciseName: trigger.exercise_name,
    weightKg: payload.weight_kg,
    openedAt: now,
  });
}
