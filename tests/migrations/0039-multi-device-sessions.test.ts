import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0039-multi-device-sessions.sql';

interface SessionRow {
  user_id: string;
  refresh_token_jti: string;
  prev_jti: string | null;
  revoked_at: Date | null;
}

describe('migration 0039 multi-device sessions', () => {
  it('creates the indexed session table and preserves every legacy jti', () => {
    const mem = makeMigrationDb();
    runMigration(mem, 'db/migrations/0001-init-users.sql');
    const userId = randomUUID();
    const jti = randomUUID();
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role, refresh_token_jti)
      VALUES ('${userId}', '+8613800000038', 'hash', 'coach', '${jti}')
    `);

    runMigration(mem, MIGRATION);

    const session = mem.public.one('SELECT * FROM sessions') as SessionRow;
    expect(session).toMatchObject({
      user_id: userId,
      refresh_token_jti: jti,
      prev_jti: null,
      revoked_at: null,
    });

    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain('BEGIN;\nSET search_path TO public;');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('sessions_refresh_token_jti_key');
    expect(sql).toContain('sessions_prev_jti_idx');
    expect(sql).toContain('sessions_user_active_last_used_idx');
  });

  it('cascades sessions when the owning user is deleted', () => {
    const mem = makeMigrationDb();
    runMigration(mem, 'db/migrations/0001-init-users.sql');
    runMigration(mem, MIGRATION);
    const userId = randomUUID();
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role)
      VALUES ('${userId}', '+8613800000138', 'hash', 'coached_student');
      INSERT INTO sessions (user_id, refresh_token_jti)
      VALUES ('${userId}', '${randomUUID()}');
      DELETE FROM users WHERE id = '${userId}';
    `);

    expect(mem.public.one('SELECT count(*) AS count FROM sessions')).toMatchObject({ count: 0 });
  });
});
