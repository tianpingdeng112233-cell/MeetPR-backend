import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const COACH = '10000000-0000-4000-8000-000000000001';
const OTHER_COACH = '10000000-0000-4000-8000-000000000002';
const PLAN = '30000000-0000-4000-8000-000000000001';

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  createPlanSchema(mem);
  runMigration(mem, 'db/migrations/0068-plan-pending-revisions.sql');
  return mem;
}

describe('migration 0068 plan pending revisions', () => {
  it('creates the table with plan primary key and both foreign keys', () => {
    const mem = setup();

    mem.public.none(`
      INSERT INTO plan_pending_revisions (
        plan_id, coach_id, version, content_hash, content
      ) VALUES (
        '${PLAN}', '${COACH}', 1, 'fnv1a32:12345678', '{"weeks":[]}'::jsonb
      );
    `);

    expect(
      mem.public.one(`
        SELECT plan_id::text, coach_id::text, version, content_hash, content, saved_at
        FROM plan_pending_revisions;
      `),
    ).toMatchObject({
      plan_id: PLAN,
      coach_id: COACH,
      version: 1,
      content_hash: 'fnv1a32:12345678',
      content: { weeks: [] },
      saved_at: expect.any(Date),
    });

    expect(() => {
      mem.public.none(`
        INSERT INTO plan_pending_revisions (
          plan_id, coach_id, version, content_hash, content
        ) VALUES (
          '${PLAN}', '${OTHER_COACH}', 2, 'fnv1a32:87654321', '{}'::jsonb
        );
      `);
    }).toThrow(/duplicate key|unique/i);
    expect(() => {
      mem.public.none(`
        INSERT INTO plan_pending_revisions (
          plan_id, coach_id, version, content_hash, content
        ) VALUES (
          '30000000-0000-4000-8000-000000000099', '${COACH}', 1, 'hash', '{}'::jsonb
        );
      `);
    }).toThrow(/foreign key|constraint/i);
    expect(() => {
      mem.public.none(`
        UPDATE plan_pending_revisions
        SET coach_id = '10000000-0000-4000-8000-000000000099'
        WHERE plan_id = '${PLAN}';
      `);
    }).toThrow(/foreign key|constraint/i);
  });

  it('cascades a pending revision when its plan is deleted', () => {
    const mem = setup();
    mem.public.none(`
      INSERT INTO plan_pending_revisions (
        plan_id, coach_id, version, content_hash, content
      ) VALUES (
        '${PLAN}', '${COACH}', 1, 'fnv1a32:12345678', '{}'::jsonb
      );
      DELETE FROM plans WHERE id = '${PLAN}';
    `);

    expect(mem.public.one('SELECT COUNT(*)::int AS count FROM plan_pending_revisions;').count).toBe(
      0,
    );
  });
});
