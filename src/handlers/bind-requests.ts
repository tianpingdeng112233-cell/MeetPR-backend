import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { BindRequestsTable, Database } from '../db/types';
import { redeemInviteCode } from './invite-codes';
import { timestamp } from './serialization';

type DbExecutor = Kysely<Database> | Transaction<Database>;
export type BindRequestRow = Selectable<BindRequestsTable>;

export interface BindRequestResponse {
  id: string;
  student_id: string;
  coach_id: string;
  coach_display_name: string | null;
  invite_code_id: string | null;
  status: BindRequestRow['status'];
  submitted_at: string;
  responded_at: string | null;
  expired_at: string;
  skip_evaluation: boolean;
  skip_reason: string | null;
}

export function toBindRequest(
  row: BindRequestRow,
  coachDisplayName: string | null = null,
): BindRequestResponse {
  return {
    id: row.id,
    student_id: row.student_id,
    coach_id: row.coach_id,
    coach_display_name: coachDisplayName,
    invite_code_id: row.invite_code_id,
    status: row.status,
    submitted_at: timestamp(row.submitted_at),
    responded_at: row.responded_at === null ? null : timestamp(row.responded_at),
    expired_at: timestamp(row.expired_at),
    skip_evaluation: row.skip_evaluation,
    skip_reason: row.skip_reason,
  };
}

/**
 * Lazy expiry (spec 005 D7): flip stale pendings to expired before any read
 * or state transition. Scoped to one student or one coach.
 */
export async function expireStaleBindRequests(
  db: DbExecutor,
  scope: { studentId: string } | { coachId: string },
): Promise<void> {
  let query = db
    .updateTable('bind_requests')
    .set({ status: 'expired' })
    .where('status', '=', 'pending')
    .where('expired_at', '<', sql<Date>`now()`);

  query =
    'studentId' in scope
      ? query.where('student_id', '=', scope.studentId)
      : query.where('coach_id', '=', scope.coachId);

  await query.execute();
}

export type CreateBindRequestResult =
  | { type: 'created'; bindRequest: BindRequestResponse }
  | { type: 'already-pending' }
  | { type: 'already-bound' }
  | { type: 'invalid-code' };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function createBindRequest(
  db: Kysely<Database>,
  studentId: string,
  input: { code: string; display_name: string },
): Promise<CreateBindRequestResult> {
  try {
    return await createBindRequestInTransaction(db, studentId, input);
  } catch (error: unknown) {
    // bind_requests_unique_pending backstops two concurrent submissions; the
    // loser reads as a duplicate, not a 500 (Codex review P1).
    if (isUniqueViolation(error)) {
      return { type: 'already-pending' };
    }
    throw error;
  }
}

async function createBindRequestInTransaction(
  db: Kysely<Database>,
  studentId: string,
  input: { code: string; display_name: string },
): Promise<CreateBindRequestResult> {
  return db.transaction().execute(async (trx): Promise<CreateBindRequestResult> => {
    await expireStaleBindRequests(trx, { studentId });

    const pending = await trx
      .selectFrom('bind_requests')
      .select(['id'])
      .where('student_id', '=', studentId)
      .where('status', '=', 'pending')
      .limit(1)
      .executeTakeFirst();
    if (pending) {
      return { type: 'already-pending' };
    }

    // All guards run BEFORE the use-count consumption: a lightweight lookup
    // resolves the coach so the already-bound case never burns a use.
    const codeRow = await trx
      .selectFrom('invite_codes')
      .select(['id', 'coach_id'])
      .where('code', '=', input.code.trim().toUpperCase())
      .executeTakeFirst();
    if (!codeRow) {
      return { type: 'invalid-code' };
    }

    const bound = await trx
      .selectFrom('bind_requests')
      .select(['id'])
      .where('student_id', '=', studentId)
      .where('coach_id', '=', codeRow.coach_id)
      .where('status', '=', 'accepted')
      .limit(1)
      .executeTakeFirst();
    if (bound) {
      return { type: 'already-bound' };
    }

    // Atomic redeem (validity + uses budget in one UPDATE, spec 005 D5).
    const redeemed = await redeemInviteCode(trx, input.code);
    if (!redeemed) {
      return { type: 'invalid-code' };
    }

    // Bootstrap the student_profiles row (spec 005 D1): registration does not
    // create one, and the coach roster inner-joins on it.
    await trx
      .insertInto('student_profiles')
      .values({ user_id: studentId, display_name: input.display_name })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          display_name: input.display_name,
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();

    const row = await trx
      .insertInto('bind_requests')
      .values({
        student_id: studentId,
        coach_id: redeemed.coach_id,
        status: 'pending',
        expired_at: sql<Date>`now() + interval '7 days'`,
        invite_code_id: redeemed.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const coachProfile = await trx
      .selectFrom('coach_profiles')
      .select(['display_name'])
      .where('user_id', '=', redeemed.coach_id)
      .executeTakeFirst();

    return { type: 'created', bindRequest: toBindRequest(row, coachProfile?.display_name ?? null) };
  });
}

/** Latest bind request for the student (any status), after lazy expiry. */
export async function fetchMyBindRequest(
  db: Kysely<Database>,
  studentId: string,
): Promise<BindRequestResponse | null> {
  await expireStaleBindRequests(db, { studentId });

  const row = await db
    .selectFrom('bind_requests as br')
    .leftJoin('coach_profiles as cp', 'cp.user_id', 'br.coach_id')
    .selectAll('br')
    .select('cp.display_name as coach_display_name')
    .where('br.student_id', '=', studentId)
    .orderBy('br.submitted_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (!row) return null;
  const { coach_display_name, ...bindRow } = row;
  return toBindRequest(bindRow, coach_display_name);
}

export type CancelBindRequestResult = 'cancelled' | 'not-found' | 'not-pending';

export async function cancelBindRequest(
  db: Kysely<Database>,
  studentId: string,
  bindRequestId: string,
): Promise<CancelBindRequestResult> {
  return db.transaction().execute(async (trx) => {
    await expireStaleBindRequests(trx, { studentId });

    const row = await trx
      .selectFrom('bind_requests')
      .select(['id', 'status'])
      .where('id', '=', bindRequestId)
      .where('student_id', '=', studentId)
      .executeTakeFirst();

    if (!row) return 'not-found';
    if (row.status !== 'pending') return 'not-pending';

    // responded_at stays null: cancellation is not a coach response.
    await trx
      .updateTable('bind_requests')
      .set({ status: 'cancelled' })
      .where('id', '=', row.id)
      .execute();

    return 'cancelled';
  });
}
