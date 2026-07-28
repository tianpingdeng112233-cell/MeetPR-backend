import type { Kysely } from 'kysely';

import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';

export interface CoachRpeUpdate {
  set_log_id: string;
  before: string | null;
  after: string | null;
}

export async function updateCoachRpe(
  db: Kysely<Database>,
  coachId: string,
  setLogId: string,
  coachRpe: number | null,
): Promise<CoachRpeUpdate | null> {
  return db.transaction().execute(async (trx) => {
    const setLog = await trx
      .selectFrom('set_logs')
      .select(['id', 'student_id', 'coach_rpe'])
      .where('id', '=', setLogId)
      .forUpdate()
      .executeTakeFirst();
    if (!setLog || !(await hasAcceptedBond(trx, coachId, setLog.student_id))) {
      return null;
    }

    const after = coachRpe === null ? null : coachRpe.toFixed(1);
    await trx
      .updateTable('set_logs')
      .set({ coach_rpe: after })
      .where('id', '=', setLog.id)
      .executeTakeFirstOrThrow();

    return {
      set_log_id: setLog.id,
      before: setLog.coach_rpe === null ? null : Number(setLog.coach_rpe).toFixed(1),
      after,
    };
  });
}
