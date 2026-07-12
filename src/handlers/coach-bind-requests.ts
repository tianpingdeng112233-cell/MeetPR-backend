import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type {
  BenchGrip,
  Database,
  DeadliftStyle,
  Gender,
  GymTier,
  InjuryArea,
  MuscleGroup,
  SquatStance,
  TrainingDay,
} from '../db/types';
import { type BindRequestResponse, expireStaleBindRequests, toBindRequest } from './bind-requests';
import { type EvaluationPeriodResponse, toEvaluationPeriod } from './evaluations';
import { dateOnly, decimal, timestamp } from './serialization';

export interface CoachBindRequestOnboardingSummary {
  completed: boolean;
  gender: Gender | null;
  birth_date: string | null;
  height_cm: string | null;
  weight_kg: string | null;
  training_years: number | null;
  squat_1rm_kg: string | null;
  bench_1rm_kg: string | null;
  deadlift_1rm_kg: string | null;
  squat_stance: SquatStance | null;
  deadlift_style: DeadliftStyle | null;
  bench_grip: BenchGrip | null;
  training_days: TrainingDay[] | null;
  injury_notes: string | null;
  injury_areas: InjuryArea[] | null;
  muscle_groups_to_strengthen: MuscleGroup[] | null;
  gym_tier: GymTier | null;
  is_competing: boolean | null;
  competition_date: string | null;
  target_weight_class: string | null;
  note_to_coach: string | null;
  upload_count: number;
}

export interface CoachBindRequestItem {
  id: string;
  student_id: string;
  display_name: string;
  submitted_at: string;
  expired_at: string;
  onboarding: CoachBindRequestOnboardingSummary;
}

/**
 * Pending receive queue with the 9-item onboarding summary per
 * evaluation-workflow §3.2. Fields are null when onboarding is incomplete.
 */
export async function fetchCoachBindRequestQueue(
  db: Kysely<Database>,
  coachId: string,
): Promise<CoachBindRequestItem[]> {
  await expireStaleBindRequests(db, { coachId });

  const rows = await db
    .selectFrom('bind_requests as br')
    .innerJoin('student_profiles as sp', 'sp.user_id', 'br.student_id')
    .leftJoin('student_onboarding_profiles as op', 'op.user_id', 'br.student_id')
    .select([
      'br.id as id',
      'br.student_id as student_id',
      'br.submitted_at as submitted_at',
      'br.expired_at as expired_at',
      'sp.display_name as display_name',
      'op.completed_at as onboarding_completed_at',
      'op.gender as gender',
      'op.birth_date as birth_date',
      'op.height_cm as height_cm',
      'op.weight_kg as weight_kg',
      'op.training_years as training_years',
      'op.squat_1rm_kg as squat_1rm_kg',
      'op.bench_1rm_kg as bench_1rm_kg',
      'op.deadlift_1rm_kg as deadlift_1rm_kg',
      'op.squat_stance as squat_stance',
      'op.deadlift_style as deadlift_style',
      'op.bench_grip as bench_grip',
      'op.training_days as training_days',
      'op.injury_notes as injury_notes',
      'op.injury_areas as injury_areas',
      'op.muscle_groups_to_strengthen as muscle_groups_to_strengthen',
      'op.gym_tier as gym_tier',
      'op.is_competing as is_competing',
      'op.competition_date as competition_date',
      'op.target_weight_class as target_weight_class',
      'op.note_to_coach as note_to_coach',
    ])
    .where('br.coach_id', '=', coachId)
    .where('br.status', '=', 'pending')
    .orderBy('br.submitted_at', 'asc')
    .execute();

  // Upload counts fetched separately and merged in JS (a correlated subquery
  // would work on real PG but is not parseable by pg-mem in tests).
  const studentIds = rows.map((row) => row.student_id);
  const uploadCounts = new Map<string, number>();
  if (studentIds.length > 0) {
    const countRows = await db
      .selectFrom('onboarding_uploads')
      .select(['user_id'])
      .select(sql<string>`count(*)`.as('upload_count'))
      .where('user_id', 'in', studentIds)
      .groupBy('user_id')
      .execute();
    for (const countRow of countRows) {
      uploadCounts.set(countRow.user_id, Number(countRow.upload_count));
    }
  }

  return rows.map((row) => ({
    id: row.id,
    student_id: row.student_id,
    display_name: row.display_name,
    submitted_at: timestamp(row.submitted_at),
    expired_at: timestamp(row.expired_at),
    onboarding: {
      completed: row.onboarding_completed_at !== null,
      gender: row.gender,
      birth_date: dateOnly(row.birth_date),
      height_cm: decimal(row.height_cm, 1),
      weight_kg: decimal(row.weight_kg, 2),
      training_years: row.training_years,
      squat_1rm_kg: decimal(row.squat_1rm_kg, 2),
      bench_1rm_kg: decimal(row.bench_1rm_kg, 2),
      deadlift_1rm_kg: decimal(row.deadlift_1rm_kg, 2),
      squat_stance: row.squat_stance,
      deadlift_style: row.deadlift_style,
      bench_grip: row.bench_grip,
      training_days: row.training_days,
      injury_notes: row.injury_notes,
      injury_areas: row.injury_areas,
      muscle_groups_to_strengthen: row.muscle_groups_to_strengthen,
      gym_tier: row.gym_tier,
      is_competing: row.is_competing,
      competition_date: dateOnly(row.competition_date),
      target_weight_class: row.target_weight_class,
      note_to_coach: row.note_to_coach,
      upload_count: uploadCounts.get(row.student_id) ?? 0,
    },
  }));
}

export type RespondBindRequestResult =
  | {
      type: 'accepted';
      bindRequest: BindRequestResponse;
      evaluationPeriod: EvaluationPeriodResponse | null;
    }
  | { type: 'rejected'; bindRequest: BindRequestResponse }
  | { type: 'not-found' }
  | { type: 'not-pending' }
  | { type: 'expired' }
  | { type: 'already-bound' };

interface AcceptInput {
  skip_evaluation: boolean;
  skip_reason: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function acceptBindRequest(
  db: Kysely<Database>,
  coachId: string,
  bindRequestId: string,
  input: AcceptInput,
): Promise<RespondBindRequestResult> {
  try {
    return await db.transaction().execute(async (trx): Promise<RespondBindRequestResult> => {
      const gate = await gatePendingRequest(trx, coachId, bindRequestId);
      if (gate.type !== 'ok') return gate;

      // Conditional transition: a concurrent cancel/reject/expiry between the
      // gate read and this write loses cleanly instead of being overwritten
      // (Codex review P1).
      const updated = await trx
        .updateTable('bind_requests')
        .set({
          status: 'accepted',
          responded_at: sql<Date>`now()`,
          skip_evaluation: input.skip_evaluation,
          skip_reason: input.skip_reason,
        })
        .where('id', '=', bindRequestId)
        .where('status', '=', 'pending')
        .where('expired_at', '>', sql<Date>`now()`)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        return { type: 'not-pending' };
      }

      let evaluationPeriod: EvaluationPeriodResponse | null = null;
      if (!input.skip_evaluation) {
        const period = await trx
          .insertInto('evaluation_periods')
          .values({
            student_id: updated.student_id,
            coach_id: coachId,
            bind_request_id: updated.id,
            expected_end_at: sql<Date>`now() + interval '7 days'`,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        evaluationPeriod = toEvaluationPeriod(period);
      }

      return { type: 'accepted', bindRequest: toBindRequest(updated), evaluationPeriod };
    });
  } catch (error: unknown) {
    // Partial unique indexes (one accepted bond / one active evaluation per
    // pair) backstop concurrent accepts.
    if (isUniqueViolation(error)) {
      return { type: 'already-bound' };
    }
    throw error;
  }
}

export async function rejectBindRequest(
  db: Kysely<Database>,
  coachId: string,
  bindRequestId: string,
): Promise<RespondBindRequestResult> {
  return db.transaction().execute(async (trx): Promise<RespondBindRequestResult> => {
    const gate = await gatePendingRequest(trx, coachId, bindRequestId);
    if (gate.type !== 'ok') return gate;

    // Silent neutral rejection: no reason field (evaluation-workflow §3.4).
    // Conditional transition mirrors accept (Codex review P1).
    const updated = await trx
      .updateTable('bind_requests')
      .set({ status: 'rejected', responded_at: sql<Date>`now()` })
      .where('id', '=', bindRequestId)
      .where('status', '=', 'pending')
      .where('expired_at', '>', sql<Date>`now()`)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      return { type: 'not-pending' };
    }

    return { type: 'rejected', bindRequest: toBindRequest(updated) };
  });
}

type PendingGate =
  | { type: 'ok' }
  | { type: 'not-found' }
  | { type: 'not-pending' }
  | { type: 'expired' };

async function gatePendingRequest(
  trx: Kysely<Database>,
  coachId: string,
  bindRequestId: string,
): Promise<PendingGate> {
  const row = await trx
    .selectFrom('bind_requests')
    .select(['id', 'status', 'expired_at'])
    .where('id', '=', bindRequestId)
    .where('coach_id', '=', coachId)
    .executeTakeFirst();

  if (!row) return { type: 'not-found' };
  if (row.status === 'pending' && new Date(row.expired_at) < new Date()) {
    // Lazy expiry on the mutation path (spec 005 D7).
    await trx
      .updateTable('bind_requests')
      .set({ status: 'expired' })
      .where('id', '=', row.id)
      .execute();
    return { type: 'expired' };
  }
  if (row.status !== 'pending') return { type: 'not-pending' };
  return { type: 'ok' };
}
