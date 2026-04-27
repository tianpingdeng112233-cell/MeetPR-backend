import pg, { type Pool, type PoolConfig } from 'pg';

const DATE_OID = 1082;

let dateParserRegistered = false;

function ensureDateParserRegistered(): void {
  if (dateParserRegistered) return;
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
  dateParserRegistered = true;
}

export function createPool(databaseUrl: string, options: PoolConfig = {}): Pool {
  ensureDateParserRegistered();

  const ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false;

  return new pg.Pool({
    connectionString: databaseUrl,
    ssl,
    ...options,
  });
}
