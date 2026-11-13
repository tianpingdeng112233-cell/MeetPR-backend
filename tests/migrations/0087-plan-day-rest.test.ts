import { expect, it } from 'vitest';
import { makeMigrationDb, runMigration } from '../helpers/migrations';

it('adds an opt-in rest flag without altering existing day identity or defaults', () => {
  const mem = makeMigrationDb();
  mem.public.none(
    'CREATE TABLE plan_days (id INTEGER PRIMARY KEY); INSERT INTO plan_days VALUES (1);',
  );
  runMigration(mem, 'db/migrations/0087-plan-day-rest.sql');
  expect(mem.public.one('SELECT * FROM plan_days')).toEqual({ id: 1, is_rest: false });
  mem.public.none('INSERT INTO plan_days (id) VALUES (2)');
  expect(mem.public.one('SELECT is_rest FROM plan_days WHERE id = 2')).toEqual({ is_rest: false });
  expect(() => {
    mem.public.none('UPDATE plan_days SET is_rest = NULL WHERE id = 1');
  }).toThrow();
});
