import bcrypt from 'bcrypt';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';

const BCRYPT_COST = 10;

export class AdminProvisioningError extends Error {
  readonly code: 'ADMIN_ALREADY_EXISTS';

  constructor() {
    super('ADMIN_ALREADY_EXISTS');
    this.name = 'AdminProvisioningError';
    this.code = 'ADMIN_ALREADY_EXISTS';
  }
}

export interface ProvisionAdminResult {
  id: string;
  action: 'created' | 'promoted' | 'updated';
}

function isSingleAdminViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  return record.code === '23505' && record.constraint === 'users_single_admin_idx';
}

export async function provisionAdmin(
  db: Kysely<Database>,
  input: { phone: string; password: string },
): Promise<ProvisionAdminResult> {
  try {
    return await db.transaction().execute(async (trx) => {
      const admin = await trx
        .selectFrom('users')
        .select(['id', 'phone'])
        .where('role', '=', 'admin')
        .forUpdate()
        .executeTakeFirst();
      // Re-running for the same phone is a password rotation, not a conflict;
      // only a *different* phone trips the single-admin rule.
      if (admin && admin.phone !== input.phone) throw new AdminProvisioningError();

      const existing =
        admin ??
        (await trx
          .selectFrom('users')
          .select(['id', 'phone'])
          .where('phone', '=', input.phone)
          .forUpdate()
          .executeTakeFirst());
      const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

      if (existing) {
        await trx
          .updateTable('users')
          .set({
            role: 'admin',
            password_hash: passwordHash,
            // Kill the legacy single-slot refresh token: an old device must
            // not be able to refresh itself into an admin token.
            refresh_token_jti: null,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', existing.id)
          .executeTakeFirstOrThrow();
        // Same reasoning for multi-device sessions (0039): every live session
        // predating the promotion/rotation is revoked.
        await trx
          .updateTable('sessions')
          .set({ revoked_at: sql<Date>`now()` })
          .where('user_id', '=', existing.id)
          .where('revoked_at', 'is', null)
          .execute();
        return { id: existing.id, action: admin ? 'updated' : 'promoted' };
      }

      const created = await trx
        .insertInto('users')
        .values({
          phone: input.phone,
          password_hash: passwordHash,
          role: 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: created.id, action: 'created' };
    });
  } catch (error: unknown) {
    if (error instanceof AdminProvisioningError || isSingleAdminViolation(error)) {
      throw new AdminProvisioningError();
    }
    throw error;
  }
}
