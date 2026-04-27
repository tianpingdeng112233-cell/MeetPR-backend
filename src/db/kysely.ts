import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import type { Database } from './types';

export function createDb(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
