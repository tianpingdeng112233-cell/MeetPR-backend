import { describe, expect, it } from 'vitest';

import { createPool } from '../../src/db/pool';

// DO's DATABASE_URL carries ?sslmode=require, and node-postgres lets in-URL
// SSL params override the explicit ssl option. With a CA supplied the pool
// must strip those params so strict verification against the private CA wins.
describe('createPool TLS handling', () => {
  it('strips sslmode from the URL and keeps the CA when one is provided', () => {
    const pool = createPool(
      'postgres://u:p@host.example:25060/defaultdb?sslmode=require',
      {},
      'FAKE-CA-PEM',
    );
    const options = pool.options as { connectionString?: string; ssl?: { ca?: string } };
    expect(options.connectionString).not.toContain('sslmode');
    expect(options.ssl?.ca).toBe('FAKE-CA-PEM');
    void pool.end();
  });

  it('leaves the connection string untouched without a CA', () => {
    const pool = createPool('postgres://u:p@host.example:5432/db?sslmode=require');
    const options = pool.options as { connectionString?: string };
    expect(options.connectionString).toContain('sslmode=require');
    void pool.end();
  });
});
