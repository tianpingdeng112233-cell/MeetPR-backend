import bcrypt from 'bcrypt';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/types';

import { createDb } from '../src/db/kysely';
import { createPool } from '../src/db/pool';

// Dedicated operational branch: create only; every existing email aborts.

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

  const db = createDb(createPool(parsed.data.DATABASE_URL, {}, parsed.data.DATABASE_CA_CERT));
  try {
    await provisionCoach(db, {
      email: parsed.data.COACH_EMAIL,
      password: parsed.data.COACH_PASSWORD,
      timezone: parsed.data.COACH_TIMEZONE,
    });
    console.log('COACH_CREATED');
  } catch (error: unknown) {
    console.error(
      error instanceof Error && error.message === 'COACH_EMAIL_EXISTS'
        ? 'COACH_EMAIL_EXISTS'
        : 'COACH_PROVISION_FAILED',
    );
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

export async function provisionCoach(
  db: Kysely<Database>,
  input: { email: string; password: string; timezone: string },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('users')
      .select('id')
      .where((eb) => eb(eb.fn<string>('lower', ['email']), '=', email))
      .executeTakeFirst();
    if (existing !== undefined) throw new Error('COACH_EMAIL_EXISTS');
    const user = await trx
      .insertInto('users')
      .values({
        phone: null,
        email,
        email_verified_at: null,
        password_hash: passwordHash,
        role: 'coach',
        timezone: input.timezone,
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
  });
}

if (require.main === module) {
  void main();
}
