import type { Transaction } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';

export async function storePasswordAndRevokeSessions(
  trx: Transaction<Database>,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await trx
    .updateTable('users')
    .set({
      password_hash: passwordHash,
      // The legacy column can backfill a session in /auth/refresh. Clearing it
      // is part of the established password-change revocation semantics.
      refresh_token_jti: null,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', userId)
    .execute();
  await trx
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
