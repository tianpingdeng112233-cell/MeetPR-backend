import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0008 invite codes', () => {
  it('allows one active personal code per coach and cascades coach delete', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0008-init-invite-codes.sql');

    mem.public.none(`
      INSERT INTO invite_codes (coach_id, code, type) VALUES
        ('10000000-0000-4000-8000-000000000001', 'AAAAAAAAAA', 'personal_permanent'),
        ('10000000-0000-4000-8000-000000000001', 'BBBBBBBBBB', 'single_use'),
        ('10000000-0000-4000-8000-000000000002', 'CCCCCCCCCC', 'personal_permanent');
    `);

    // Second active personal code for the same coach violates the partial index.
    expect(() => {
      mem.public.none(`
        INSERT INTO invite_codes (coach_id, code, type)
        VALUES ('10000000-0000-4000-8000-000000000001', 'DDDDDDDDDD', 'personal_permanent');
      `);
    }).toThrow();

    // Revoking the active one frees the slot.
    mem.public.none(`
      UPDATE invite_codes SET revoked_at = now() WHERE code = 'AAAAAAAAAA';
      INSERT INTO invite_codes (coach_id, code, type)
      VALUES ('10000000-0000-4000-8000-000000000001', 'DDDDDDDDDD', 'personal_permanent');
    `);

    // Duplicate code text is globally unique.
    expect(() => {
      mem.public.none(`
        INSERT INTO invite_codes (coach_id, code, type)
        VALUES ('10000000-0000-4000-8000-000000000002', 'BBBBBBBBBB', 'single_use');
      `);
    }).toThrow();

    // Cascade on coach delete. Scoped to coach 2 (single active personal code)
    // because pg-mem resolves the FK scan through the partial index and would
    // miss coach 1's revoked/non-personal rows; real PG cascades all rows.
    mem.public.none(`DELETE FROM users WHERE id = '10000000-0000-4000-8000-000000000002';`);
    const remaining = mem.public.many(`SELECT coach_id FROM invite_codes`);
    expect(remaining).toHaveLength(3);
    expect(
      remaining.every(
        (row: { coach_id: string }) => row.coach_id === '10000000-0000-4000-8000-000000000001',
      ),
    ).toBe(true);
  });
});
