import { describe, expect, it } from 'vitest';
import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const migration = 'db/migrations/0073-coach-pages.sql';
describe('migration 0073 coach pages', () => {
  it('is additive and reentrant and cascades pages and enquiries on account deletion', () => {
    // Like the 0072 migration test: pg-mem otherwise rejects ignored CREATE IF NOT EXISTS AST nodes.
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0003.5-init-profile-tables.sql');
    const coach = '10000000-0000-4000-8000-000000000001';
    mem.public.none(
      `INSERT INTO coach_profiles (user_id, display_name) VALUES ('${coach}', 'Original')`,
    );
    const users = mem.public.many('SELECT * FROM users');
    const profiles = mem.public.many('SELECT * FROM coach_profiles') as Record<string, unknown>[];
    runMigration(mem, migration);
    expect(mem.public.many('SELECT * FROM users')).toEqual(users);
    expect(mem.public.many('SELECT * FROM coach_profiles')).toEqual(
      profiles.map((p) => ({ ...p, subscription_expires_at: null })),
    );
    expect(mem.public.many('SELECT * FROM coach_pages')).toEqual([]);
    mem.public.none(`INSERT INTO coach_pages (coach_id, slug) VALUES ('${coach}', 'test-coach');
      INSERT INTO coach_enquiries (coach_id, name, contact, source_hash) VALUES ('${coach}', 'Visitor', 'contact', 'hash')`);
    const pages = mem.public.many('SELECT * FROM coach_pages');
    const enquiries = mem.public.many('SELECT * FROM coach_enquiries');
    runMigration(mem, migration);
    expect(mem.public.many('SELECT * FROM coach_pages')).toEqual(pages);
    expect(mem.public.many('SELECT * FROM coach_enquiries')).toEqual(enquiries);
    mem.public.none(`DELETE FROM users WHERE id = '${coach}'`);
    expect(mem.public.many('SELECT * FROM coach_pages')).toEqual([]);
    expect(mem.public.many('SELECT * FROM coach_enquiries')).toEqual([]);
  });
});
