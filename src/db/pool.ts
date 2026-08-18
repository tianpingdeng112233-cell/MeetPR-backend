import pg, { type Pool, type PoolConfig } from 'pg';

const DATE_OID = 1082;

let dateParserRegistered = false;

function ensureDateParserRegistered(): void {
  if (dateParserRegistered) return;
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
  dateParserRegistered = true;
}

export function createPool(databaseUrl: string, options: PoolConfig = {}, caCert?: string): Pool {
  ensureDateParserRegistered();

  // Managed Postgres providers with private CAs (DO) inject the CA via env;
  // verification stays strict. Without a CA this is byte-identical to before.
  // node-postgres lets SSL params inside the connection string override the
  // explicit `ssl` option, so when a CA is supplied the sslmode/ssl* query
  // params are stripped first — otherwise DO's `?sslmode=require` would wipe
  // the CA and certificate verification would fail.
  let connectionString = databaseUrl;
  if (caCert !== undefined) {
    const url = new URL(databaseUrl);
    for (const param of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      url.searchParams.delete(param);
    }
    connectionString = url.toString();
  }

  const ssl =
    process.env.NODE_ENV === 'production'
      ? caCert !== undefined
        ? { rejectUnauthorized: true, ca: caCert }
        : { rejectUnauthorized: true }
      : caCert !== undefined
        ? { rejectUnauthorized: true, ca: caCert }
        : false;

  return new pg.Pool({
    connectionString,
    ssl,
    ...options,
  });
}
