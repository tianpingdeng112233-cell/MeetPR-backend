import bcrypt from 'bcrypt';
import { z } from 'zod';

import { createDb } from '../src/db/kysely';
import { createPool } from '../src/db/pool';

// Overseas coach provisioning: the Global track has no phone numbers and no
// self-signup for coaches, so an operator inserts the account directly —
// same trust model as scripts/create-admin.ts, email edition. Idempotent on
// email: an existing coach gets its password rotated instead of a dup row.

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  COACH_EMAIL: z.string().trim().email().max(320),
  COACH_PASSWORD: z
    .string()
    .min(8, 'COACH_PASSWORD must be at least 8 characters')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
      message: 'COACH_PASSWORD must be at most 72 UTF-8 bytes',
    }),
  DATABASE_CA_CERT: z.string().min(1).optional(),
  COACH_TIMEZONE: z
    .string()
    .min(1)
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'COACH_TIMEZONE must be a valid IANA time zone' },
    ),
});

const BCRYPT_COST = 10;

async function main(): Promise<void> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('COACH_ENV_INVALID');
    for (const issue of parsed.error.issues) {
      console.error(`${issue.path.join('.')}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const email = parsed.data.COACH_EMAIL.toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.COACH_PASSWORD, BCRYPT_COST);

  const pool = createPool(parsed.data.DATABASE_URL, {}, parsed.data.DATABASE_CA_CERT);
  const db = createDb(pool);
  try {
    const outcome = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('users')
        .select(['id', 'role'])
        .where('email', '=', email)
        .executeTakeFirst();

      if (existing !== undefined) {
        if (existing.role !== 'coach') {
          throw new Error(`EMAIL_TAKEN_BY_ROLE:${existing.role}`);
        }
        await trx
          .updateTable('users')
          .set({ password_hash: passwordHash })
          .where('id', '=', existing.id)
          .execute();
        return 'rotated';
      }

      const user = await trx
        .insertInto('users')
        .values({
          phone: null,
          email,
          email_verified_at: null,
          password_hash: passwordHash,
          role: 'coach',
          timezone: parsed.data.COACH_TIMEZONE,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('user_identities')
        .values({
          user_id: user.id,
          provider: 'email',
          provider_uid: email,
          email_at_provider: email,
        })
        .execute();
      return 'created';
    });
    console.log(`COACH_${outcome.toUpperCase()}`);
  } catch (error: unknown) {
    console.error('COACH_PROVISION_FAILED');
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  void main();
}
