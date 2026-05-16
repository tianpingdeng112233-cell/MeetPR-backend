import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';

export async function markFeedbackRead(
  db: Kysely<Database>,
  feedbackId: string,
  studentId: string,
): Promise<boolean> {
  const result = await db
    .updateTable('feedback')
    .set({ read_at: sql<Date>`COALESCE(read_at, now())` })
    .where('id', '=', feedbackId)
    .where('student_id', '=', studentId)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) > 0;
}
