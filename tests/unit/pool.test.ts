import { describe, expect, it } from 'vitest';

import { resolveDatabaseSsl } from '../../src/db/pool';

describe('resolveDatabaseSsl', () => {
  it('disables SSL when DATABASE_SSL=disable', () => {
    expect(resolveDatabaseSsl('disable', 'production')).toBe(false);
  });

  it('requires SSL without CA verification when DATABASE_SSL=require', () => {
    expect(resolveDatabaseSsl('require', 'production')).toEqual({ rejectUnauthorized: false });
  });

  it('requires SSL with CA verification when DATABASE_SSL=verify', () => {
    expect(resolveDatabaseSsl('verify', 'development')).toEqual({ rejectUnauthorized: true });
  });

  it('keeps legacy production default when DATABASE_SSL is unset', () => {
    expect(resolveDatabaseSsl(undefined, 'production')).toEqual({ rejectUnauthorized: true });
  });

  it('keeps legacy non-production default when DATABASE_SSL is unset', () => {
    expect(resolveDatabaseSsl(undefined, 'development')).toBe(false);
  });
});
