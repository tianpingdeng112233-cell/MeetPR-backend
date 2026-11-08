import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBaseUsers, makeMigrationDb } from '../helpers/migrations';

describe('0077 preferred locale', () => {
  it('adds only a nullable checked preference, keeps old rows and supports reruns', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    const before = mem.public.many('SELECT * FROM users ORDER BY id') as Record<string, unknown>[];
    const source = readFileSync('db/migrations/0077-users-preferred-locale.sql', 'utf8');
    const inlineCheck = /CHECK \(([^;]+)\);/;
    const expression = inlineCheck.exec(source)?.[1];
    if (expression === undefined) throw new Error('migration must retain its locale CHECK');
    // pg-mem cannot add an inline CHECK to a populated table (Corrupted alias),
    // and incorrectly treats NULL IN (...) as false. Replay the same constraint
    // at table level with PostgreSQL's nullable CHECK semantics made explicit.
    // The unchanged source SQL is also verified separately on PGlite PostgreSQL.
    let applied = false;
    const migrate = () => {
      if (applied) {
        mem.public.none(source);
        return;
      }
      mem.public.none(source.replace(inlineCheck, ';'));
      mem.public.none(`ALTER TABLE users ADD CONSTRAINT users_preferred_locale_check
        CHECK (preferred_locale IS NULL OR (${expression}))`);
      applied = true;
    };
    migrate();
    expect(mem.public.many('SELECT * FROM users ORDER BY id')).toEqual(
      before.map((row) => ({ ...row, preferred_locale: null })),
    );
    for (const locale of ['zh-Hans', 'zh-Hant', 'en']) {
      mem.public.none(`UPDATE users SET preferred_locale = '${locale}'`);
      migrate();
      expect(
        mem.public
          .many('SELECT preferred_locale FROM users')
          .every((row) => row.preferred_locale === locale),
      ).toBe(true);
    }
    expect(() => {
      mem.public.none("UPDATE users SET preferred_locale = 'zh-TW'");
    }).toThrow();
    mem.public.none('UPDATE users SET preferred_locale = NULL');
  });
});
