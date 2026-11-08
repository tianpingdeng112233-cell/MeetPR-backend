import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';

/** Look up a usable invitation without consuming a use; callers validate the code format. */
export async function findValidInvite(db: Kysely<Database>, code: string) {
  return db
    .selectFrom('invite_codes as i')
    .innerJoin('users as u', 'u.id', 'i.coach_id')
    .leftJoin('coach_profiles as p', 'p.user_id', 'i.coach_id')
    .select('p.display_name')
    .where('i.code', '=', code)
    .where('u.role', '=', 'coach')
    .where('i.revoked_at', 'is', null)
    .where((eb) =>
      eb.or([eb('i.expires_at', 'is', null), eb('i.expires_at', '>', sql<Date>`now()`)]),
    )
    .where((eb) =>
      eb.or([eb('i.max_uses', 'is', null), eb('i.used_count', '<', eb.ref('i.max_uses'))]),
    )
    .executeTakeFirst();
}
