import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const path = 'db/migrations/0079-coach-student-plan-views.sql';
const coach = '10000000-0000-4000-8000-000000000001';
const student = '10000000-0000-4000-8000-000000000003';
describe('migration 0079 coach student plan views', () => {
  it('reapplies without changing existing rows and supports documented down/up', () => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    createBaseUsers(mem);
    const users = mem.public.many('SELECT * FROM users');
    runMigration(mem, path);
    mem.public.none(
      `INSERT INTO coach_student_plan_views VALUES ('${coach}', '${student}', '2026-10-22T12:00:00Z')`,
    );
    const views = mem.public.many('SELECT * FROM coach_student_plan_views');
    runMigration(mem, path);
    expect(mem.public.many('SELECT * FROM coach_student_plan_views')).toEqual(views);
    const down = /-- Down: (.+)/.exec(fs.readFileSync(path, 'utf8'))?.[1];
    expect(down).toBe('DROP TABLE IF EXISTS coach_student_plan_views;');
    // pg-mem leaves composite PK index names behind after DROP TABLE (also
    // reproducible with a two-int table). Remove its index before exercising
    // the documented down/up; the unmodified SQL is also checked on PostgreSQL.
    mem.public.none('DROP INDEX coach_student_plan_views_pkey');
    if (down === undefined) throw new Error('Missing documented down migration');
    mem.public.none(down);
    runMigration(mem, path);
    expect(mem.public.many('SELECT * FROM coach_student_plan_views')).toEqual([]);
    expect(mem.public.many('SELECT * FROM users')).toEqual(users);
  });
  it('enforces the composite primary key, required timestamp and both user references', () => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    createBaseUsers(mem);
    runMigration(mem, path);
    const insert = (coachId: string, studentId: string, time = "'2026-10-22T12:00:00Z'") => {
      mem.public.none(
        `INSERT INTO coach_student_plan_views VALUES ('${coachId}', '${studentId}', ${time})`,
      );
    };
    insert(coach, student);
    expect(() => {
      insert(coach, student);
    }).toThrow();
    expect(() => {
      insert(student, coach, 'NULL');
    }).toThrow();
    expect(() => {
      insert('90000000-0000-4000-8000-000000000000', student);
    }).toThrow();
    expect(() => {
      insert(coach, '90000000-0000-4000-8000-000000000000');
    }).toThrow();
  });
  it.each([coach, student])('cascades deletion of either referenced user %s', (userId) => {
    const mem = makeMigrationDb({ noAstCoverageCheck: true });
    createBaseUsers(mem);
    runMigration(mem, path);
    mem.public.none(
      `INSERT INTO coach_student_plan_views VALUES ('${coach}', '${student}', '2026-10-22T12:00:00Z')`,
    );
    mem.public.none(`DELETE FROM users WHERE id = '${userId}'`);
    expect(mem.public.many('SELECT * FROM coach_student_plan_views')).toEqual([]);
  });
});
