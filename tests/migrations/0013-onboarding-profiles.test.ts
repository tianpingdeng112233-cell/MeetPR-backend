import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0013 onboarding profiles', () => {
  it('upserts on user_id, caps muscle groups at 3, and cascades user delete', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0013-init-onboarding-profiles.sql');

    mem.public.none(`
      INSERT INTO student_onboarding_profiles (user_id, gender, muscle_groups_to_strengthen)
      VALUES ('10000000-0000-4000-8000-000000000003', 'male', ARRAY['quad','hamstring','shoulder']);
    `);

    // Re-entrant upsert on the PK.
    mem.public.none(`
      INSERT INTO student_onboarding_profiles (user_id, gender)
      VALUES ('10000000-0000-4000-8000-000000000003', 'female')
      ON CONFLICT (user_id) DO UPDATE SET gender = excluded.gender, updated_at = now();
    `);
    const rows = mem.public.many(`SELECT gender FROM student_onboarding_profiles`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gender).toBe('female');

    // 4 muscle groups violate the array_length CHECK.
    expect(() => {
      mem.public.none(`
        UPDATE student_onboarding_profiles
        SET muscle_groups_to_strengthen = ARRAY['quad','hamstring','shoulder','back'];
      `);
    }).toThrow();

    // Scale band over 5 violates the CHECK.
    expect(() => {
      mem.public.none(`UPDATE student_onboarding_profiles SET life_stress = 6;`);
    }).toThrow();

    // Composite PK on uploads dedupes (user, attachment).
    mem.public.none(`
      INSERT INTO onboarding_uploads (user_id, attachment_id)
      VALUES ('10000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001');
    `);
    expect(() => {
      mem.public.none(`
        INSERT INTO onboarding_uploads (user_id, attachment_id)
        VALUES ('10000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001');
      `);
    }).toThrow();

    mem.public.none(`DELETE FROM users WHERE id = '10000000-0000-4000-8000-000000000003';`);
    expect(mem.public.many(`SELECT * FROM student_onboarding_profiles`)).toHaveLength(0);
    expect(mem.public.many(`SELECT * FROM onboarding_uploads`)).toHaveLength(0);
  });
});
