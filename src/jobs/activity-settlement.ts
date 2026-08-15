import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { judgeMissedTraining, type TrainingCalendarEntry } from '../domain/missed-training';
import { effectivePlanDays } from '../domain/plan-calendar';
import { SIGNAL_POLICY } from '../domain/signal-policy';
import { sweepTimedOutSessions } from '../handlers/activity-ledger';
import type { Logger } from '../logger';
import { pushDisplayName, tryEnqueuePushOutbox } from '../services/push-outbox';
import { isIsoCalendarDate, normalizeDateOnly } from '../utils/date';
import { DEFAULT_TIME_ZONE } from '../utils/timezone';

type SettlementLogger = Pick<Logger, 'warn'>;
type SettlementTransaction = Transaction<Database>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DateOnlySchema = z.string().refine(isIsoCalendarDate, 'must be a real YYYY-MM-DD date');

const MissedTrainingPayloadSchema = z
  .object({
    missed_dates: z.array(DateOnlySchema).min(1),
    consecutive_count: z.number().int().positive(),
    plan_id: z.string().uuid(),
    streak_start_date: DateOnlySchema,
    // Coach-level absence-epoch anchor: the student's last real training day,
    // or 'never'. Signal dedup keys on this — plan-scoped streak starts move
    // when the per-coach winner plan switches, the epoch does not.
    absence_epoch: z.union([DateOnlySchema, z.literal('never')]),
  })
  .refine((payload) => payload.consecutive_count === payload.missed_dates.length, {
    message: 'consecutive_count must match missed_dates',
  })
  .refine((payload) => payload.streak_start_date === payload.missed_dates[0], {
    message: 'streak_start_date must anchor missed_dates',
  });

type MissedTrainingPayload = z.infer<typeof MissedTrainingPayloadSchema>;

interface MissedTrainingPushCandidate {
  signalId: string;
  studentId: string;
  coachId: string;
  consecutiveDays: number;
}

function parseMissedPayload(value: Record<string, unknown> | string): MissedTrainingPayload | null {
  try {
    const decoded = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    const parsed = MissedTrainingPayloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Total order over absence epochs: 'never' (no training ever) precedes every
 * date; dates compare lexicographically. Sorting '' before any ISO date gives
 * exactly that.
 */
function epochRank(epoch: string): string {
  return epoch === 'never' ? '' : epoch;
}

function humanDate(date: string): string {
  const [, month = '', day = ''] = date.split('-');
  return `${String(Number(month))}-${String(Number(day))}`;
}

function missedReason(payload: MissedTrainingPayload): string {
  return `连续 ${String(payload.consecutive_count)} 个训练日未打卡（${payload.missed_dates.map(humanDate).join(' / ')}）`;
}

async function lockStudent(trx: SettlementTransaction, studentId: string): Promise<boolean> {
  return (
    (await trx
      .selectFrom('users')
      .select('id')
      .where('id', '=', studentId)
      .forUpdate()
      .executeTakeFirst()) !== undefined
  );
}

async function autoResolveCurrentDay(
  trx: SettlementTransaction,
  studentId: string,
  gymDay: string,
  now: Date,
): Promise<boolean> {
  const started =
    (await trx
      .selectFrom('set_logs')
      .select('id')
      .where('student_id', '=', studentId)
      .where('logged_date', '=', gymDay)
      .where('assumed', '=', false)
      .executeTakeFirst()) !== undefined;
  if (!started) return false;

  // Training on gymDay only ends absence periods that began BEFORE it. A
  // historical rerun (gymDay older than an open signal's epoch) must not
  // resolve the newer absence.
  const openSignals = await trx
    .selectFrom('student_signals')
    .select(['id', 'payload'])
    .where('student_id', '=', studentId)
    .where('signal_type', '=', 'missed_training')
    .where('status', '=', 'open')
    .forUpdate()
    .execute();
  const resolvableIds = openSignals
    .filter((signal) => {
      const payload = parseMissedPayload(signal.payload);
      return payload === null || epochRank(payload.absence_epoch) < gymDay;
    })
    .map((signal) => signal.id);
  if (resolvableIds.length > 0) {
    await trx
      .updateTable('student_signals')
      .set({ status: 'auto_resolved', resolved_at: now, updated_at: now })
      .where('id', 'in', resolvableIds)
      .where('status', '=', 'open')
      .execute();
  }
  return true;
}

async function upsertMissedSignal(
  trx: SettlementTransaction,
  input: {
    studentId: string;
    coachId: string;
    payload: MissedTrainingPayload;
    now: Date;
  },
): Promise<MissedTrainingPushCandidate | null> {
  const signals = await trx
    .selectFrom('student_signals')
    .select(['id', 'status', 'payload'])
    .where('student_id', '=', input.studentId)
    .where('coach_id', '=', input.coachId)
    .where('signal_type', '=', 'missed_training')
    .orderBy('opened_at', 'desc')
    .forUpdate()
    .execute();

  // One absence epoch (= no real training since input.payload.absence_epoch)
  // maps to at most one signal row per coach. Within the epoch the open row
  // follows the per-coach winner plan freely; once the coach acked it (or it
  // closed any other way) nothing may reopen until real training starts a new
  // epoch.
  const incomingRank = epochRank(input.payload.absence_epoch);
  const knownRanks = signals
    .map((signal) => parseMissedPayload(signal.payload)?.absence_epoch)
    .filter((epoch): epoch is string => epoch !== undefined)
    .map(epochRank);
  // A settlement older than anything already recorded is a historical rerun —
  // it must never regress newer state (§5 rerun safety).
  if (knownRanks.some((rank) => rank > incomingRank)) return null;

  const sameEpoch = signals.filter(
    (signal) => parseMissedPayload(signal.payload)?.absence_epoch === input.payload.absence_epoch,
  );
  const sameEpochOpen = sameEpoch.find((signal) => signal.status === 'open');
  if (sameEpochOpen !== undefined) {
    const existingPayload = parseMissedPayload(sameEpochOpen.payload);
    // missed_dates ends at the judged gym-day, so it doubles as the row's
    // settled-through watermark: a same-epoch rerun of an OLDER gym-day must
    // not roll the winner or the count backwards (§5 rerun safety).
    const incomingThrough = input.payload.missed_dates.at(-1) ?? '';
    const existingThrough = existingPayload?.missed_dates.at(-1) ?? '';
    if (existingPayload !== null && incomingThrough < existingThrough) return null;
    if (
      existingPayload !== null &&
      existingPayload.consecutive_count === input.payload.consecutive_count &&
      existingPayload.plan_id === input.payload.plan_id
    ) {
      return null;
    }
    await trx
      .updateTable('student_signals')
      .set({
        reason: missedReason(input.payload),
        payload: JSON.stringify(input.payload),
        expires_at: new Date(input.now.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS),
        updated_at: input.now,
      })
      .where('id', '=', sameEpochOpen.id)
      .where('status', '=', 'open')
      .execute();
    return null;
  }
  if (sameEpoch.length > 0) return null;

  // A different epoch means the student actually trained in between — the old
  // open signal (if any) is superseded by the new absence period.
  const otherOpen = signals.find((signal) => signal.status === 'open');
  if (otherOpen !== undefined) {
    await trx
      .updateTable('student_signals')
      .set({ status: 'auto_resolved', resolved_at: input.now, updated_at: input.now })
      .where('id', '=', otherOpen.id)
      .where('status', '=', 'open')
      .execute();
  }

  const inserted = await trx
    .insertInto('student_signals')
    .values({
      student_id: input.studentId,
      coach_id: input.coachId,
      signal_type: 'missed_training',
      severity: 'red',
      status: 'open',
      reason: missedReason(input.payload),
      payload: JSON.stringify(input.payload),
      opened_at: input.now,
      expires_at: new Date(input.now.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS),
      updated_at: input.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    signalId: inserted.id,
    studentId: input.studentId,
    coachId: input.coachId,
    consecutiveDays: input.payload.consecutive_count,
  };
}

async function settleStudent(
  trx: SettlementTransaction,
  studentId: string,
  gymDay: string,
  now: Date,
): Promise<MissedTrainingPushCandidate[]> {
  // LOCK CONTRACT: every student_signals mutation is below this row lock.
  if (!(await lockStudent(trx, studentId))) return [];

  const acceptedBonds = await trx
    .selectFrom('bind_requests')
    .select('coach_id')
    .where('student_id', '=', studentId)
    .where('status', '=', 'accepted')
    .execute();
  const coachIds = [...new Set(acceptedBonds.map((bond) => bond.coach_id))];
  if (coachIds.length === 0) return [];

  const currentDayStarted = await autoResolveCurrentDay(trx, studentId, gymDay, now);
  const evaluationExempt =
    (await trx
      .selectFrom('evaluation_periods')
      .select('id')
      .where('student_id', '=', studentId)
      .where('completed_at', 'is', null)
      .executeTakeFirst()) !== undefined;

  const plans = await trx
    .selectFrom('plans')
    .select(['id', 'coach_id', 'start_date', 'status', 'created_at'])
    .where('trainee_id', '=', studentId)
    .where('coach_id', 'in', coachIds)
    .where('status', '=', 'published')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const planIds = plans.map((plan) => plan.id);
  const days =
    planIds.length === 0
      ? []
      : await trx
          .selectFrom('plan_days')
          .selectAll()
          .where('plan_id', 'in', planIds)
          .orderBy('week_number', 'asc')
          .orderBy('day_of_week', 'asc')
          .orderBy('id', 'asc')
          .execute();
  const dayIds = days.map((day) => day.id);
  const shifts =
    dayIds.length === 0
      ? []
      : await trx
          .selectFrom('plan_day_shifts')
          .selectAll()
          .where('plan_day_id', 'in', dayIds)
          .execute();

  const daysByPlan = new Map<string, typeof days>();
  for (const day of days) {
    const planDays = daysByPlan.get(day.plan_id) ?? [];
    planDays.push(day);
    daysByPlan.set(day.plan_id, planDays);
  }

  const startedRows = await trx
    .selectFrom('set_logs')
    .select('logged_date')
    .where('student_id', '=', studentId)
    .where('assumed', '=', false)
    .execute();
  const startedGymDays = new Set(startedRows.map((row) => normalizeDateOnly(row.logged_date)));
  if (currentDayStarted) startedGymDays.add(gymDay);

  // One judgment per plan: merging calendars would let one coach's misses
  // inflate another coach's streak and misattribute the signal. Per coach the
  // longest triggered streak wins (one open missed_training row per pair).
  type PlanRowLite = (typeof plans)[number];
  const winnerByCoach = new Map<
    string,
    { plan: PlanRowLite; judgement: ReturnType<typeof judgeMissedTraining> }
  >();
  for (const plan of plans) {
    if (plan.coach_id === null) continue;
    const calendar: TrainingCalendarEntry[] = effectivePlanDays(
      plan,
      daysByPlan.get(plan.id) ?? [],
      shifts,
    ).map((item) => ({ date: item.effectiveDate, planId: plan.id, planStatus: plan.status }));
    const judgement = judgeMissedTraining({
      gymDay,
      trainingCalendar: calendar,
      startedGymDays,
      evaluationExempt,
      threshold: SIGNAL_POLICY.missedDaysThreshold,
    });
    if (!judgement.triggered || judgement.streakStartDate === null) continue;
    const current = winnerByCoach.get(plan.coach_id);
    if (current === undefined || judgement.consecutiveCount > current.judgement.consecutiveCount) {
      winnerByCoach.set(plan.coach_id, { plan, judgement });
    }
  }

  const pushCandidates: MissedTrainingPushCandidate[] = [];
  for (const { plan, judgement } of winnerByCoach.values()) {
    if (plan.coach_id === null || judgement.streakStartDate === null) continue;
    const payload = MissedTrainingPayloadSchema.parse({
      missed_dates: judgement.missedDates,
      consecutive_count: judgement.consecutiveCount,
      plan_id: plan.id,
      streak_start_date: judgement.streakStartDate,
      absence_epoch: judgement.lastTrainedDate ?? 'never',
    });
    const pushCandidate = await upsertMissedSignal(trx, {
      studentId,
      coachId: plan.coach_id,
      payload,
      now,
    });
    if (pushCandidate !== null) pushCandidates.push(pushCandidate);
  }
  return pushCandidates;
}

export async function expireOpenSignalsForTimeZone(
  db: Kysely<Database>,
  now: Date,
  logger?: SettlementLogger,
  timezone = DEFAULT_TIME_ZONE,
): Promise<void> {
  const candidates = await db
    .selectFrom('student_signals as ss')
    .innerJoin('users as student', 'student.id', 'ss.student_id')
    .select('ss.student_id')
    .distinct()
    .where('ss.status', '=', 'open')
    .where('ss.expires_at', '<', now)
    .where('student.timezone', '=', timezone)
    .execute();

  for (const candidate of candidates) {
    try {
      await db.transaction().execute(async (trx) => {
        if (!(await lockStudent(trx, candidate.student_id))) return;
        await trx
          .updateTable('student_signals')
          .set({ status: 'expired', updated_at: now })
          .where('student_id', '=', candidate.student_id)
          .where('status', '=', 'open')
          .where('expires_at', '<', now)
          .execute();
      });
    } catch (err) {
      logger?.warn(
        { err, studentId: candidate.student_id },
        'activity_settlement_signal_expiry_failed',
      );
    }
  }
}

export async function runDailySettlement(
  db: Kysely<Database>,
  gymDay: string,
  now: Date = new Date(),
  logger?: SettlementLogger,
  pushEnabled = false,
  timezone = DEFAULT_TIME_ZONE,
): Promise<string[]> {
  const students = await db
    .selectFrom('bind_requests as br')
    .innerJoin('users as u', 'u.id', 'br.student_id')
    .select('br.student_id as student_id')
    .distinct()
    .where('br.status', '=', 'accepted')
    .where('u.role', '=', 'coached_student')
    .where('u.timezone', '=', timezone)
    .execute();

  const failedStudentIds: string[] = [];
  for (const student of students) {
    try {
      const pushCandidates = await db
        .transaction()
        .execute((trx) => settleStudent(trx, student.student_id, gymDay, now));
      if (pushEnabled && logger !== undefined) {
        for (const candidate of pushCandidates) {
          await tryEnqueuePushOutbox(db, logger, 'missed_training', async () => ({
            aggregateId: candidate.signalId,
            recipientId: candidate.coachId,
            payload: {
              student_name: await pushDisplayName(db, candidate.studentId),
              consecutive_days: candidate.consecutiveDays,
              student_id: candidate.studentId,
            },
          }));
        }
      }
    } catch (err) {
      failedStudentIds.push(student.student_id);
      logger?.warn(
        { err, studentId: student.student_id, gymDay },
        'activity_settlement_student_failed',
      );
    }
  }
  return failedStudentIds;
}

export async function runSessionSweep(db: Kysely<Database>, now: Date): Promise<void> {
  await sweepTimedOutSessions(db, now);
}
