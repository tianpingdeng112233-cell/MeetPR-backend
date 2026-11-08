import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const path = 'db/migrations/0082-coach-unbind-alias.sql';
const coach = '10000000-0000-4000-8000-000000000001';
const student = '10000000-0000-4000-8000-000000000003';

function migrationRunner(mem: ReturnType<typeof makeMigrationDb>) {
  let enumAdded = false;
  return () => {
    const sql = fs.readFileSync(path, 'utf8');
    const enumStatement = "ALTER TYPE bind_request_status ADD VALUE IF NOT EXISTS 'ended';";
    expect(sql).toContain(enumStatement);
    // pg-mem supports ADD VALUE, but cannot parse its IF NOT EXISTS clause.
    // Adapt only this clause; real PostgreSQL must verify the original script.
    mem.public.none(
      sql.replace(
        enumStatement,
        enumAdded ? '' : "ALTER TYPE bind_request_status ADD VALUE 'ended';",
      ),
    );
    enumAdded = true;
  };
}

describe('migration 0082 coach unbind and student alias', () => {
  it.each([false, true])(
    'runs twice without changing existing bonds (populated=%s)',
    (populated) => {
      const mem = makeMigrationDb({ noAstCoverageCheck: true });
      createBaseUsers(mem);
      runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');
      if (populated) {
        mem.public.none(`INSERT INTO bind_requests (coach_id, student_id, status, expired_at)
        VALUES ('${coach}', '${student}', 'accepted', '2026-12-01T00:00:00Z')`);
      }
      const before = mem.public.many('SELECT * FROM bind_requests') as Record<string, unknown>[];
      const migrate = migrationRunner(mem);
      migrate();
      migrate();
      expect(mem.public.many('SELECT * FROM bind_requests')).toEqual(
        before.map((row) => ({ ...row, ended_at: null })),
      );
      mem.public
        .none(`INSERT INTO bind_requests (coach_id, student_id, status, expired_at, ended_at)
      VALUES ('${coach}', '${student}', 'ended', now(), now())`);
      mem.public.none(`INSERT INTO coach_student_aliases (coach_id, student_id, alias)
      VALUES ('${coach}', '${student}', '学员备注')`);
      migrate();
      expect(mem.public.one('SELECT alias FROM coach_student_aliases').alias).toBe('学员备注');
    },
  );
});

it('enforces alias length, composite uniqueness and cascading user references', () => {
  const mem = makeMigrationDb({ noAstCoverageCheck: true });
  createBaseUsers(mem);
  runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');
  migrationRunner(mem)();
  const insert = (name: string | null, coachId = coach, studentId = student) => {
    mem.public.none(
      `INSERT INTO coach_student_aliases (coach_id, student_id, alias) VALUES ('${coachId}', '${studentId}', ${name === null ? 'NULL' : `'${name}'`})`,
    );
  };
  for (const name of ['', 'a'.repeat(101), null])
    expect(() => {
      insert(name);
    }).toThrow();
  expect(() => {
    insert('valid', '90000000-0000-4000-8000-000000000001');
  }).toThrow();
  expect(() => {
    insert('valid', coach, '90000000-0000-4000-8000-000000000001');
  }).toThrow();
  insert('a'.repeat(100));
  expect(() => {
    insert('duplicate');
  }).toThrow();
  insert('student-side cascade', student, coach);
  mem.public.none(`DELETE FROM users WHERE id = '${coach}'`);
  expect(mem.public.many('SELECT * FROM coach_student_aliases')).toEqual([]);
});
