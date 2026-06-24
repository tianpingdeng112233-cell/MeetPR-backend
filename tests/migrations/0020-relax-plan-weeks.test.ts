import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const coachId = '10000000-0000-4000-8000-000000000001';
const traineeId = '10000000-0000-4000-8000-000000000003';
const planId = '30000000-0000-4000-8000-000000000001';

// Reproduces the post-0003 named CHECK constraints this migration widens, so the
// test exercises the real DROP/ADD-CONSTRAINT path rather than a stand-in.
function createConstrainedPlanTables(mem: ReturnType<typeof makeMigrationDb>): void {
  mem.public.none(`
    CREATE TABLE plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      trainee_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      plan_weeks SMALLINT NOT NULL,
      CONSTRAINT plans_plan_weeks_check CHECK (plan_weeks IN (1, 4))
    );

    CREATE TABLE plan_days (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      week_number SMALLINT NOT NULL,
      CONSTRAINT plan_days_week_number_check CHECK (week_number BETWEEN 1 AND 4)
    );
  `);
  mem.public.none(`
    INSERT INTO plans (id, coach_id, trainee_id, plan_weeks)
    VALUES ('${planId}', '${coachId}', '${traineeId}', 4);
    INSERT INTO plan_days (plan_id, week_number) VALUES ('${planId}', 1);
  `);
}

describe('migration 0020 relax plan weeks', () => {
  it('rejects out-of-preset plan_weeks=2 and week_number=5 before the migration', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createConstrainedPlanTables(mem);

    // plan_weeks was restricted to the {1, 4} presets...
    expect(() => {
      mem.public.none(
        `INSERT INTO plans (coach_id, trainee_id, plan_weeks) VALUES ('${coachId}', '${traineeId}', 2);`,
      );
    }).toThrow();
    // ...and week_number to the 1..4 range.
    expect(() => {
      mem.public.none(`INSERT INTO plan_days (plan_id, week_number) VALUES ('${planId}', 5);`);
    }).toThrow();
  });

  it('accepts any 1..52 weeks after the migration without disturbing {1,4} rows', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createConstrainedPlanTables(mem);

    runMigration(mem, 'db/migrations/0020-relax-plan-weeks.sql');

    // Previously-rejected mid-range values now insert.
    mem.public.none(
      `INSERT INTO plans (coach_id, trainee_id, plan_weeks) VALUES ('${coachId}', '${traineeId}', 2);`,
    );
    mem.public.none(`INSERT INTO plan_days (plan_id, week_number) VALUES ('${planId}', 2);`);
    mem.public.none(`INSERT INTO plan_days (plan_id, week_number) VALUES ('${planId}', 52);`);

    // The legacy {1, 4} presets remain valid.
    mem.public.none(
      `INSERT INTO plans (coach_id, trainee_id, plan_weeks) VALUES ('${coachId}', '${traineeId}', 1);`,
    );

    // The seeded 4-week plan is untouched.
    const seeded = mem.public.one(`SELECT plan_weeks FROM plans WHERE id = '${planId}';`);
    expect(seeded).toEqual({ plan_weeks: 4 });

    // The widened bound still has a ceiling.
    expect(() => {
      mem.public.none(`INSERT INTO plan_days (plan_id, week_number) VALUES ('${planId}', 53);`);
    }).toThrow();
  });
});
