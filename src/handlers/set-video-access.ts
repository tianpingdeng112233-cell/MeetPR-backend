import type { Kysely, RawBuilder } from 'kysely';
import { sql } from 'kysely';

import { hasAcceptedBond } from '../db/bonds';
import type { Database, UserRole } from '../db/types';
import { uuidEquals } from '../utils/uuid';
import type { AttachmentRow } from './attachments';

type AttachmentTableAlias = 'attachments' | 'a';

export type SetVideoAccess =
  | { outcome: 'allowed'; relation: 'owner' | 'bonded_coach'; video: AttachmentRow }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

/**
 * Immutable provenance gate shared by the video wall and every direct set-video
 * access path. A null source alone is legacy/unknown provenance and stays
 * private; only an explicitly unlinked upload is shared across accepted bonds.
 */
export function coachSetVideoProvenancePredicate(
  coachId: string,
  tableAlias: AttachmentTableAlias = 'attachments',
): RawBuilder<boolean> {
  const sourceCoachId = sql.ref(`${tableAlias}.source_coach_id`);
  const isUnlinkedExplicit = sql.ref(`${tableAlias}.is_unlinked_explicit`);

  return sql<boolean>`(
    (${isUnlinkedExplicit} = TRUE AND ${sourceCoachId} IS NULL)
    OR ${sourceCoachId} = ${coachId}
  )`;
}

/**
 * Resolves a direct set-video lookup without leaking provenance-hidden rows.
 * Status is deliberately returned to the caller so an accessible non-ready
 * upload can use the same 409 contract as GET /uploads/:id/url.
 */
export async function resolveSetVideoAccess(
  db: Kysely<Database>,
  actor: { id: string; role: UserRole },
  videoId: string,
): Promise<SetVideoAccess> {
  const video = await db
    .selectFrom('attachments')
    .selectAll()
    .where('id', '=', videoId)
    .executeTakeFirst();

  if (video?.kind !== 'set_video') {
    return { outcome: 'not_found' };
  }

  if (uuidEquals(video.owner_id, actor.id)) {
    return { outcome: 'allowed', relation: 'owner', video };
  }

  if (actor.role !== 'coach' || !(await hasAcceptedBond(db, actor.id, video.owner_id))) {
    return { outcome: 'forbidden' };
  }

  const provenanceVisible = await db
    .selectFrom('attachments')
    .select('id')
    .where('id', '=', video.id)
    .where(coachSetVideoProvenancePredicate(actor.id))
    .executeTakeFirst();
  if (!provenanceVisible) {
    return { outcome: 'not_found' };
  }

  return { outcome: 'allowed', relation: 'bonded_coach', video };
}
