import type { Kysely } from 'kysely';
import type { Database } from '../../db/types';
import type { TokenUsage } from './model';

export const DAILY_LIMIT = 3;

/** Calendar midnight in Shanghai, not the training-day cutover used elsewhere. */
export function shanghaiDay(now = new Date()) {
  const date = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export async function remainingToday(
  db: Kysely<Database>,
  coachId: string,
  traineeId: string,
  now = new Date(),
) {
  const { start, end } = shanghaiDay(now);
  const row = await db
    .selectFrom('plan_import_runs')
    .select((eb) => eb.fn.countAll<string | number>().as('count'))
    .where('coach_id', '=', coachId)
    .where('trainee_id', '=', traineeId)
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .executeTakeFirstOrThrow();
  return Math.max(0, DAILY_LIMIT - Number(row.count));
}

export async function recordOutline(
  db: Kysely<Database>,
  input: {
    coach_id: string;
    trainee_id: string;
    source: 'file' | 'paste';
    input_chars: number;
  } & TokenUsage,
) {
  // Only the short quota check/insert is serialized. Never hold a lock during inference.
  return db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('users')
      .select('id')
      .where('id', '=', input.coach_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = new Date();
    if ((await remainingToday(tx, input.coach_id, input.trainee_id, now)) === 0) return undefined;
    return tx
      .insertInto('plan_import_runs')
      .values({ ...input, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
  });
}

export async function claimWeekCall(db: Kysely<Database>, coachId: string, importId: string) {
  const { start, end } = shanghaiDay();
  return db
    .updateTable('plan_import_runs')
    .set((eb) => ({ week_calls: eb('week_calls', '+', 1) }))
    .where('id', '=', importId)
    .where('coach_id', '=', coachId)
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .where('week_calls', '<', 8)
    .returning('id')
    .executeTakeFirst();
}
