import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0064-global-identity.sql';

describe('migration 0064 global identity', () => {
  it('applies to a clean users table and is reentrant', () => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    runMigration(mem, 'db/migrations/0001-init-users.sql');

    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    mem.public.none(`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (
        '10000000-0000-4000-8000-000000006401',
        'Student@Example.com',
        'hash',
        'coached_student'
      );
      INSERT INTO user_identities (user_id, provider, provider_uid, email_at_provider)
      VALUES (
        '10000000-0000-4000-8000-000000006401',
        'email',
        'student@example.com',
        'Student@Example.com'
      );
      INSERT INTO auth_challenges (nonce_hash)
      VALUES ('6f5db55b42a0f0906e1adf41a3e03b227bd399af8a3fe565e055c505b45aeda9');
    `);

    expect(mem.public.one(`SELECT phone, email_verified_at FROM users;`)).toEqual({
      phone: null,
      email_verified_at: null,
    });
    expect(mem.public.one(`SELECT nonce_hash FROM auth_challenges;`)).toEqual({
      nonce_hash: '6f5db55b42a0f0906e1adf41a3e03b227bd399af8a3fe565e055c505b45aeda9',
    });
    expect(
      mem.public
        .getTable('user_identities')
        .listIndices()
        .find((candidate) => candidate.name === 'user_identities_user_id_idx'),
    ).toMatchObject({ expressions: ['user_id'], unique: false });
  });

  it('preserves existing phone rows without identity backfill', () => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    runMigration(mem, 'db/migrations/0001-init-users.sql');
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role)
      VALUES (
        '10000000-0000-4000-8000-000000006402',
        '+8613800064002',
        'existing-hash',
        'coached_student'
      );
    `);

    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    expect(
      mem.public.one(`
        SELECT phone, password_hash, email, email_verified_at
        FROM users
        WHERE id = '10000000-0000-4000-8000-000000006402';
      `),
    ).toEqual({
      phone: '+8613800064002',
      password_hash: 'existing-hash',
      email: null,
      email_verified_at: null,
    });
    expect(mem.public.many(`SELECT * FROM user_identities;`)).toEqual([]);
  });

  it('enforces case-insensitive email and provider identity uniqueness', () => {
    const mem = makeMigrationDb();
    runMigration(mem, 'db/migrations/0001-init-users.sql');
    runMigration(mem, MIGRATION);

    mem.public.none(`
      INSERT INTO users (id, email, password_hash, role) VALUES
        ('10000000-0000-4000-8000-000000006403', 'first@example.com', 'hash', 'coached_student'),
        ('10000000-0000-4000-8000-000000006404', NULL, 'hash', 'coached_student');
      INSERT INTO user_identities (user_id, provider, provider_uid)
      VALUES ('10000000-0000-4000-8000-000000006403', 'google', 'provider-user');
    `);

    expect(() => {
      mem.public.none(`
        UPDATE users
        SET email = 'FIRST@EXAMPLE.COM'
        WHERE id = '10000000-0000-4000-8000-000000006404';
      `);
    }).toThrow();
    expect(() => {
      mem.public.none(`
        INSERT INTO user_identities (user_id, provider, provider_uid)
        VALUES ('10000000-0000-4000-8000-000000006404', 'google', 'provider-user');
      `);
    }).toThrow();
    expect(() => {
      mem.public.none(`
        INSERT INTO user_identities (user_id, provider, provider_uid)
        VALUES ('10000000-0000-4000-8000-000000006404', 'github', 'provider-user-2');
      `);
    }).toThrow();
  });
});
