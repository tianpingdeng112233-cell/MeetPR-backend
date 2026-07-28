import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import { LIFT_FAMILIES, type Database, type LiftFamily } from '../db/types';
import { resolveCompetitionFamily } from '../domain/e1rm';
import { SIGNAL_POLICY } from '../domain/signal-policy';
import { normalizeDateOnly } from '../utils/date';
import { resolveEventCoachId } from './activity-ledger';

type DbExecutor = Kysely<Database> | Transaction<Database>;

const LegacyPrEventPayloadSchema = z.object({
  set_log_id: z.string().uuid(),
  exercise_id: z.string().uuid(),
  family: z.enum(LIFT_FAMILIES),
  e1rm: z.number().positive().finite(),
  previous_best: z.number().positive().finite(),
  logged_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const PrEventPayloadSchema = LegacyPrEventPayloadSchema.extend({
  metric: z.literal('actual_weight'),
  weight_kg: z.number().positive().finite(),
  previous_best_weight_kg: z.number().positive().finite(),
});

type PrEventPayload = z.infer<typeof PrEventPayloadSchema>;
type CompatiblePrEventPayload = PrEventPayload | z.infer<typeof LegacyPrEventPayloadSchema>;

const FAMILY_LABELS: Record<LiftFamily, string> = {
  squat: '深蹲',
  bench: '卧推',
  deadlift: '硬拉',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function payloadWeight(payload: CompatiblePrEventPayload): number {
  return 'weight_kg' in payload ? payload.weight_kg : payload.e1rm;
}

function reasonFor(payload: PrEventPayload): string {
  return `${FAMILY_LABELS[payload.family]}实测重量新高 ${payload.weight_kg.toFixed(1)}kg（此前最好 ${payload.previous_best_weight_kg.toFixed(1)}kg）`;
}

function parsePayload(value: Record<string, unknown> | string): CompatiblePrEventPayload | null {
  try {
    const decoded = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    const parsed = z.union([PrEventPayloadSchema, LegacyPrEventPayloadSchema]).safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function updateOpenCongrats(
  db: DbExecutor,
  input: {
    studentId: string;
    coachId: string;
    payload: PrEventPayload;
    openedAt: Date;
    expiresAt: Date;
  },
): Promise<boolean> {
  const existing = await db
    .selectFrom('student_signals')
    .select(['id', 'reason', 'payload'])
    .where('student_id', '=', input.studentId)
    .where('coach_id', '=', input.coachId)
    .where('signal_type', '=', 'pr_congrats')
    .where('status', '=', 'open')
    .forUpdate()
    .executeTakeFirst();
  if (!existing) return false;

  const existingPayload = parsePayload(existing.payload);
  const winningPayload =
    existingPayload !== null && payloadWeight(existingPayload) >= input.payload.weight_kg
      ? existingPayload
      : input.payload;
  const winningReason =
    winningPayload === existingPayload ? existing.reason : reasonFor(input.payload);

  const updated = await db
    .updateTable('student_signals')
    .set({
      reason: winningReason,
      payload: JSON.stringify(winningPayload),
      opened_at: input.openedAt,
      expires_at: input.expiresAt,
      updated_at: input.openedAt,
    })
    .where('id', '=', existing.id)
    .where('status', '=', 'open')
    .returning('id')
    .executeTakeFirst();
  return updated !== undefined;
}

async function upsertOpenCongrats(
  db: DbExecutor,
  input: {
    studentId: string;
    coachId: string;
    payload: PrEventPayload;
    openedAt: Date;
  },
): Promise<void> {
  const expiresAt = new Date(input.openedAt.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS);

  // LOCK CONTRACT: every writer of open student_signals rows must take this
  // student-row lock first. It fully serializes the select-then-insert below —
  // ON CONFLICT cannot target the partial open-signal index under pg-mem, and
  // catching 23505 inside a transaction is unusable on real PostgreSQL (the
  // transaction is aborted, see the sets-log.ts adhoc note). If a 23505 ever
  // fires here a writer broke the contract; failing this (PR-only)
  // transaction loudly is the correct outcome.
  await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', input.studentId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  if (await updateOpenCongrats(db, { ...input, expiresAt })) return;

  await db
    .insertInto('student_signals')
    .values({
      student_id: input.studentId,
      coach_id: input.coachId,
      signal_type: 'pr_congrats',
      severity: 'green',
      status: 'open',
      reason: reasonFor(input.payload),
      payload: JSON.stringify(input.payload),
      opened_at: input.openedAt,
      expires_at: expiresAt,
      updated_at: input.openedAt,
    })
    .execute();
}

/**
 * Detect an actual-weight PR for one persisted set log. The legacy event name
 * remains for live-client compatibility. Callers own the transaction so the
 * fact event and optional coach signal commit atomically with the ledger.
 */
export async function detectSetLogPr(
  db: DbExecutor,
  studentId: string,
  setLogId: string,
  now: Date = new Date(),
): Promise<void> {
  const trigger = await db
    .selectFrom('set_logs as sl')
    .innerJoin('exercises as e', 'e.id', 'sl.exercise_id')
    .leftJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
    .leftJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .leftJoin('plans as p', 'p.id', 'pd.plan_id')
    .select([
      'sl.exercise_id as exercise_id',
      'sl.weight_kg as weight_kg',
      'sl.completed as completed',
      'sl.failed as failed',
      'sl.assumed as assumed',
      'sl.logged_date as logged_date',
      'sl.logged_at as logged_at',
      'e.main_lift_family as main_lift_family',
      'e.is_competition_lift as is_competition_lift',
      'e.competition_stance as competition_stance',
      'p.coach_id as plan_coach_id',
    ])
    .where('sl.id', '=', setLogId)
    .where('sl.student_id', '=', studentId)
    .executeTakeFirst();
  if (!trigger || trigger.assumed) return;

  const onboarding = await db
    .selectFrom('student_onboarding_profiles')
    .select(['squat_stance', 'deadlift_style', 'squat_1rm_kg', 'bench_1rm_kg', 'deadlift_1rm_kg'])
    .where('user_id', '=', studentId)
    .executeTakeFirst();
  const stance = {
    squat_stance: onboarding?.squat_stance ?? null,
    deadlift_style: onboarding?.deadlift_style ?? null,
  };
  const family = resolveCompetitionFamily(trigger, stance);
  const currentWeight = Number(trigger.weight_kg);
  if (
    family === null ||
    !trigger.completed ||
    trigger.failed ||
    !Number.isFinite(currentWeight) ||
    currentWeight <= 0
  ) {
    return;
  }

  const candidates = await db
    .selectFrom('set_logs as sl')
    .innerJoin('exercises as e', 'e.id', 'sl.exercise_id')
    .select([
      'sl.weight_kg as weight_kg',
      'e.main_lift_family as main_lift_family',
      'e.is_competition_lift as is_competition_lift',
      'e.competition_stance as competition_stance',
    ])
    .where('sl.student_id', '=', studentId)
    .where('sl.id', '!=', setLogId)
    // Imported-history rows (assumed=true) never trigger a PR themselves (see
    // the trigger guard above) but DO raise the baseline: an experienced
    // lifter importing 12 weeks of history must not get fake PRs afterwards
    // (2026-07-09 decision ④, spec 053).
    .where('sl.completed', '=', true)
    .where('sl.failed', '=', false)
    .execute();

  let historicalBest: number | null = null;
  for (const candidate of candidates) {
    const candidateFamily = resolveCompetitionFamily(candidate, stance);
    if (candidateFamily !== family) continue;
    const candidateWeight = Number(candidate.weight_kg);
    if (
      Number.isFinite(candidateWeight) &&
      candidateWeight > 0 &&
      (historicalBest === null || candidateWeight > historicalBest)
    ) {
      historicalBest = candidateWeight;
    }
  }

  const registeredOneRm = Number(
    family === 'squat'
      ? onboarding?.squat_1rm_kg
      : family === 'bench'
        ? onboarding?.bench_1rm_kg
        : onboarding?.deadlift_1rm_kg,
  );
  const baselines = [
    historicalBest,
    Number.isFinite(registeredOneRm) && registeredOneRm > 0 ? registeredOneRm : null,
  ].filter((value): value is number => value !== null);
  if (baselines.length === 0) return;

  const previousBest = Math.max(...baselines);
  if (currentWeight <= previousBest) return;

  const payload = PrEventPayloadSchema.parse({
    set_log_id: setLogId,
    exercise_id: trigger.exercise_id,
    family,
    metric: 'actual_weight',
    weight_kg: currentWeight,
    previous_best_weight_kg: previousBest,
    // Legacy aliases retained because live clients decode these keys.
    e1rm: currentWeight,
    previous_best: previousBest,
    logged_date: normalizeDateOnly(trigger.logged_date),
  });
  const dedupKey = `pr:${studentId}:${family}:${setLogId}`;
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
      event_type: 'pr_e1rm',
      session_date: payload.logged_date,
      occurred_at: trigger.logged_at,
      payload: JSON.stringify(payload),
      dedup_key: dedupKey,
    })
    .onConflict((oc) => oc.column('dedup_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!insertedEvent || coachId === null) return;

  await upsertOpenCongrats(db, {
    studentId,
    coachId,
    payload,
    openedAt: now,
  });
}
