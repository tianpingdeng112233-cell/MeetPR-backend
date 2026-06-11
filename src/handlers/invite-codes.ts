import { randomInt } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { Database, InviteCodesTable, InviteCodeType } from '../db/types';
import { timestamp } from './serialization';

type DbExecutor = Kysely<Database> | Transaction<Database>;
type InviteCodeRow = Selectable<InviteCodesTable>;

// 32-char alphabet without the ambiguous I / O / 0 / 1 (spec 005 D4).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const CODE_INSERT_ATTEMPTS = 3;

export interface InviteCodeResponse {
  id: string;
  coach_id: string;
  code: string;
  type: InviteCodeType;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  label: string | null;
  created_at: string;
}

export interface CreateInviteCodeInput {
  type: InviteCodeType;
  label: string | null;
  expires_in_days: number | null;
}

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  }
  return code;
}

export function toInviteCode(row: InviteCodeRow): InviteCodeResponse {
  return {
    id: row.id,
    coach_id: row.coach_id,
    code: row.code,
    type: row.type,
    max_uses: row.max_uses,
    used_count: row.used_count,
    expires_at: row.expires_at === null ? null : timestamp(row.expires_at),
    revoked_at: row.revoked_at === null ? null : timestamp(row.revoked_at),
    label: row.label,
    created_at: timestamp(row.created_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function createInviteCode(
  db: Kysely<Database>,
  coachId: string,
  input: CreateInviteCodeInput,
): Promise<InviteCodeResponse> {
  const row = await db.transaction().execute(async (trx) => {
    if (input.type === 'personal_permanent') {
      // Regenerating the personal code auto-revokes the previous active one;
      // the partial unique index backstops this invariant (spec 005 D6).
      await trx
        .updateTable('invite_codes')
        .set({ revoked_at: sql<Date>`now()` })
        .where('coach_id', '=', coachId)
        .where('type', '=', 'personal_permanent')
        .where('revoked_at', 'is', null)
        .execute();
    }

    for (let attempt = 1; attempt <= CODE_INSERT_ATTEMPTS; attempt += 1) {
      try {
        return await trx
          .insertInto('invite_codes')
          .values({
            coach_id: coachId,
            code: generateInviteCode(),
            type: input.type,
            max_uses: input.type === 'single_use' ? 1 : null,
            expires_at:
              input.type === 'time_limited' && input.expires_in_days !== null
                ? new Date(Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000)
                : null,
            label: input.label,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error: unknown) {
        // Retry only on code collision; the random space (32^10) makes
        // more than one collision in a row effectively impossible.
        if (!isUniqueViolation(error) || attempt === CODE_INSERT_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error('unreachable');
  });

  return toInviteCode(row);
}

export async function listInviteCodes(
  db: DbExecutor,
  coachId: string,
): Promise<InviteCodeResponse[]> {
  const rows = await db
    .selectFrom('invite_codes')
    .selectAll()
    .where('coach_id', '=', coachId)
    .orderBy('created_at', 'desc')
    .execute();

  return rows.map(toInviteCode);
}

/** Revoke own code. Idempotent: re-revoking keeps the original revoked_at. */
export async function revokeInviteCode(
  db: DbExecutor,
  coachId: string,
  codeId: string,
): Promise<boolean> {
  const result = await db
    .updateTable('invite_codes')
    .set({ revoked_at: sql<Date>`COALESCE(revoked_at, now())` })
    .where('id', '=', codeId)
    .where('coach_id', '=', coachId)
    .returning(['id'])
    .executeTakeFirst();

  return result !== undefined;
}

/**
 * Atomically consume one use of a code. Single UPDATE guards revocation,
 * expiry, and the uses budget — no read-then-write race (spec 005 D5).
 * Returns the owning coach id, or null when the code is unusable.
 */
export async function redeemInviteCode(
  db: DbExecutor,
  rawCode: string,
): Promise<{ id: string; coach_id: string } | null> {
  const code = rawCode.trim().toUpperCase();
  const row = await db
    .updateTable('invite_codes')
    .set({ used_count: sql<number>`used_count + 1` })
    .where('code', '=', code)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .where((eb) => eb.or([eb('max_uses', 'is', null), eb('used_count', '<', eb.ref('max_uses'))]))
    .returning(['id', 'coach_id'])
    .executeTakeFirst();

  return row ?? null;
}
