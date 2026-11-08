import { describe, expect, it } from 'vitest';
import { makeMigrationDb, runMigration } from '../helpers/migrations';

const migration = 'db/migrations/0072-email-signup-codes.sql';
describe('migration 0072 email signup codes', () => {
  it('applies on a clean database and is reentrant without changing existing codes', () => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    runMigration(mem, migration);
    mem.public.none(
      "INSERT INTO email_signup_codes (email, code_hash, expires_at) VALUES ('student@example.com', 'digest', '2026-10-10T12:10:00Z')",
    );
    const before = mem.public.many('SELECT * FROM email_signup_codes');
    runMigration(mem, migration);
    expect(mem.public.many('SELECT * FROM email_signup_codes')).toEqual(before);
    expect(before).toEqual([
      expect.objectContaining({
        email: 'student@example.com',
        attempts: 0,
        used_at: null,
        created_at: expect.any(Date),
        id: expect.any(String),
      }),
    ]);
    expect(
      mem.public
        .getTable('email_signup_codes')
        .listIndices()
        .find((index) => index.name === 'email_signup_codes_email_idx'),
    ).toMatchObject({ expressions: ['email'], unique: false });
  });
});
