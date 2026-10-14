import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/types';

export type DeleteSetLogError =
  | 'SET_NOT_FOUND'
  | 'SET_NOT_STUDENT_ADDED'
  | 'SET_HAS_ATTACHMENT'
  | 'SET_HAS_COACH_FEEDBACK';

export async function deleteStudentAddedSetLog(
  db: Kysely<Database>,
  studentId: string,
  setLogId: string,
): Promise<DeleteSetLogError | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('set_logs')
      .selectAll()
      .where('id', '=', setLogId)
      .where('student_id', '=', studentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return 'SET_NOT_FOUND';
    const prescribed =
      row.plan_exercise_id === null
        ? null
        : await trx
            .selectFrom('plan_sets')
            .select((eb) => eb.fn.countAll<string | number>().as('count'))
            .where('plan_exercise_id', '=', row.plan_exercise_id)
            .executeTakeFirstOrThrow();
    const isAddedExercise = row.adhoc && row.plan_day_id !== null;
    const isExtraSet = prescribed !== null && row.set_index >= Number(prescribed.count);
    if (row.assumed || (!isAddedExercise && !isExtraSet)) return 'SET_NOT_STUDENT_ADDED';
    // The source-row lock also serializes coach RPE writes and new chat
    // references; attachment inserts acquire a conflicting FK key-share lock.
    const attachment = await trx
      .selectFrom('attachments')
      .select('id')
      .where('set_log_id', '=', row.id)
      .limit(1)
      .executeTakeFirst();
    const chat = await trx
      .selectFrom('messages')
      .select('id')
      .where(sql<string>`lower(set_ref ->> 'set_log_id')`, '=', row.id.toLowerCase())
      .limit(1)
      .executeTakeFirst();
    if (attachment || chat) return 'SET_HAS_ATTACHMENT';
    if (row.coach_rpe !== null) return 'SET_HAS_COACH_FEEDBACK';

    // PR/events and settled sessions are historical snapshots, just as when
    // an existing set is written back with completed:false. Do not erase them.
    await trx.deleteFrom('set_logs').where('id', '=', row.id).execute();
    return null;
  });
}
