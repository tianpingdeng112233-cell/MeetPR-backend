import pg, { type Pool, type PoolConfig } from 'pg';

import type { Config } from '../config';

const DATE_OID = 1082;

let dateParserRegistered = false;

function ensureDateParserRegistered(): void {
  if (dateParserRegistered) return;
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
  dateParserRegistered = true;
}

type DatabaseSslMode = Config['DATABASE_SSL'];

export function resolveDatabaseSsl(
  mode: DatabaseSslMode,
  nodeEnv: Config['NODE_ENV'],
): PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify') return { rejectUnauthorized: true };

  return nodeEnv === 'production' ? { rejectUnauthorized: true } : false;
}

export function createPool(
  databaseUrl: string,
  options: PoolConfig = {},
  databaseSslMode: DatabaseSslMode = process.env.DATABASE_SSL as DatabaseSslMode,
  nodeEnv: Config['NODE_ENV'] = process.env.NODE_ENV as Config['NODE_ENV'],
): Pool {
  ensureDateParserRegistered();

  const ssl = resolveDatabaseSsl(databaseSslMode, nodeEnv);

  return new pg.Pool({
    connectionString: databaseUrl,
    ssl,
    ...options,
  });
}
