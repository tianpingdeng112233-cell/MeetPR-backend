import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../db/types';
import { dateOnly, decimal } from './serialization';

/** Serialize all body-weight writers, including first writes without a profile. */
export async function lockBodyWeightUser(trx: Transaction<Database>, userId: string) {
  return trx
    .selectFrom('users')
    .select('timezone')
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function upsertBodyWeightRecord(
  trx: Transaction<Database>,
  userId: string,
  recordedOn: string,
  weightKg: string,
) {
  const row = await trx
    .insertInto('body_weight_records')
    .values({ user_id: userId, recorded_on: recordedOn, weight_kg: weightKg })
    .onConflict((oc) =>
      oc
        .columns(['user_id', 'recorded_on'])
        .doUpdateSet({ weight_kg: weightKg, updated_at: sql<Date>`now()` }),
    )
    .returning(['recorded_on', 'weight_kg'])
    .executeTakeFirstOrThrow();
  return { recorded_on: dateOnly(row.recorded_on), weight_kg: Number(row.weight_kg).toFixed(2) };
}

async function syncProfile(trx: Transaction<Database>, userId: string) {
  const latest = await trx
    .selectFrom('body_weight_records')
    .select('weight_kg')
    .where('user_id', '=', userId)
    .orderBy('recorded_on', 'desc')
    .limit(1)
    .executeTakeFirst();
  const weight = latest?.weight_kg ?? null;
  await trx
    .insertInto('student_onboarding_profiles')
    .values({ user_id: userId, weight_kg: weight })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ weight_kg: weight, updated_at: sql<Date>`now()` }),
    )
    .execute();
  return decimal(weight, 2);
}

export async function fetchBodyWeights(db: Kysely<Database>, userId: string) {
  const rows = await db
    .selectFrom('body_weight_records')
    .select(['recorded_on', 'weight_kg'])
    .where('user_id', '=', userId)
    .orderBy('recorded_on', 'asc')
    .execute();
  return rows.map((row) => ({
    recorded_on: dateOnly(row.recorded_on),
    weight_kg: Number(row.weight_kg).toFixed(2),
  }));
}

export async function putBodyWeight(
  db: Kysely<Database>,
  userId: string,
  date: string,
  weightKg: string,
) {
  return db.transaction().execute(async (trx) => {
    await lockBodyWeightUser(trx, userId);
    const record = await upsertBodyWeightRecord(trx, userId, date, weightKg);
    return { record, current_weight_kg: await syncProfile(trx, userId) };
  });
}

export async function deleteBodyWeight(db: Kysely<Database>, userId: string, date: string) {
  return db.transaction().execute(async (trx) => {
    await lockBodyWeightUser(trx, userId);
    const deleted = await trx
      .deleteFrom('body_weight_records')
      .where('user_id', '=', userId)
      .where('recorded_on', '=', date)
      .returning('user_id')
      .executeTakeFirst();
    if (!deleted) return null;
    return { current_weight_kg: await syncProfile(trx, userId) };
  });
}
