import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

describe('migration 0010 plan kind', () => {
  it('defaults to regular and rejects multi-week adaptation plans', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, 'db/migrations/0010-add-plan-kind.sql');

    // Pre-existing seed plan from createPlanSchema picked up the default.
    const seeded = mem.public.many(`SELECT kind FROM plans`);
    expect(seeded[0]?.kind).toBe('regular');

    mem.public.none(`
      INSERT INTO plans (coach_id, trainee_id, name, start_date, end_date, plan_weeks, source, status, kind)
      VALUES (
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000003',
        'Adaptation Week', '2026-06-15', '2026-06-21', 1, 'coach', 'draft', 'adaptation'
      );
    `);

    // kind='adaptation' with plan_weeks=4 violates the cross-column CHECK.
    expect(() => {
      mem.public.none(`
        INSERT INTO plans (coach_id, trainee_id, name, start_date, end_date, plan_weeks, source, status, kind)
        VALUES (
          '10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000003',
          'Bad Adaptation', '2026-06-15', '2026-07-12', 4, 'coach', 'draft', 'adaptation'
        );
      `);
    }).toThrow();

    // Unknown kind value violates the enum CHECK.
    expect(() => {
      mem.public.none(`
        INSERT INTO plans (coach_id, trainee_id, name, start_date, end_date, plan_weeks, source, status, kind)
        VALUES (
          '10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000003',
          'Bad Kind', '2026-06-15', '2026-06-21', 1, 'coach', 'draft', 'bogus'
        );
      `);
    }).toThrow();
  });
});
