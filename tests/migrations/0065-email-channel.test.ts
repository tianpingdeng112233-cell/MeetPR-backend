import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0065-email-channel.sql';

function createPre0065Schema(mem: ReturnType<typeof makeMigrationDb>): void {
  runMigration(mem, 'db/migrations/0001-init-users.sql');
  runMigration(mem, 'db/migrations/0064-global-identity.sql');
}

describe('migration 0065 email channel', () => {
  it('applies to a clean pre-0065 database, is reentrant, and leaves existing rows untouched', () => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    createPre0065Schema(mem);

    // Rows that predate 0065 prove the migration rewrites nothing.
    mem.public.none(`
      INSERT INTO users (id, email, password_hash, role)
      VALUES ('10000000-0000-4000-8000-000000006501', 'reset@example.com', 'hash', 'coached_student');
      INSERT INTO user_identities (user_id, provider, provider_uid, email_at_provider)
      VALUES (
        '10000000-0000-4000-8000-000000006501',
        'apple',
        'apple-subject',
        'reset@example.com'
      );
    `);

    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    expect(
      mem.public.one(
        `SELECT provider, provider_uid, email_at_provider, apple_refresh_token FROM user_identities;`,
      ),
    ).toEqual({
      provider: 'apple',
      provider_uid: 'apple-subject',
      email_at_provider: 'reset@example.com',
      apple_refresh_token: null,
    });

    mem.public.none(`
      UPDATE user_identities SET apple_refresh_token = 'apple-refresh-token'
      WHERE provider = 'apple';
      INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
      VALUES (
        '10000000-0000-4000-8000-000000006501',
        'sha256-digest',
        '2026-08-14T12:10:00Z'
      );
    `);

    expect(mem.public.one(`SELECT attempts, used_at FROM password_reset_codes;`)).toEqual({
      attempts: 0,
      used_at: null,
    });
    expect(mem.public.one(`SELECT apple_refresh_token FROM user_identities;`)).toEqual({
      apple_refresh_token: 'apple-refresh-token',
    });
    expect(
      mem.public
        .getTable('password_reset_codes')
        .listIndices()
        .find((candidate) => candidate.name === 'password_reset_codes_user_id_idx'),
    ).toMatchObject({ expressions: ['user_id'], unique: false });
  });

  it('cascades reset codes with the owning user', () => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    createPre0065Schema(mem);
    runMigration(mem, MIGRATION);
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role)
      VALUES ('10000000-0000-4000-8000-000000006502', '+447700900502', 'hash', 'coached_student');
      INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
      VALUES (
        '10000000-0000-4000-8000-000000006502',
        'sha256-digest',
        '2026-08-14T12:10:00Z'
      );
      DELETE FROM users WHERE id = '10000000-0000-4000-8000-000000006502';
    `);

    expect(mem.public.one(`SELECT count(*)::int AS count FROM password_reset_codes;`)).toEqual({
      count: 0,
    });
  });
});
