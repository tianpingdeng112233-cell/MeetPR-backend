import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import type { OssService, OssSignOptions } from '../services/oss';

interface WarnLogger {
  warn: (obj: unknown, msg: string) => void;
}

/**
 * Resolves presigned-URL sign options for the authenticated requester.
 * Global-track users (phone IS NULL, spec 039) get the transfer-accelerated
 * host when the service has an accelerate endpoint configured (spec 041).
 *
 * Returns null only when the user row no longer exists — callers answer 401
 * like the rest of the auth surface. A failing lookup degrades to default-host
 * signing instead: acceleration is an optimization and must never add an error
 * face (a transient DB error mapped to 401 would sign clients out).
 */
export async function requesterOssSignOptions(
  db: Kysely<Database>,
  oss: OssService | undefined,
  userId: string,
  logger?: WarnLogger,
): Promise<OssSignOptions | null> {
  if (oss?.accelerationEnabled !== true) return { useAccelerateEndpoint: false };
  try {
    const requester = await db
      .selectFrom('users')
      .select('phone')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (requester === undefined) return null;
    return { useAccelerateEndpoint: requester.phone === null };
  } catch (err) {
    logger?.warn({ err, userId }, 'oss_accelerate_lookup_failed');
    return { useAccelerateEndpoint: false };
  }
}
