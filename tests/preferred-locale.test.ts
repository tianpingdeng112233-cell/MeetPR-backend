import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { request, type InMemoryResponse } from './helpers/inMemoryRequest';
import { auth, ids, makeContext } from './helpers/studentActions';

describe('authenticated language reporting', () => {
  it('ignores platform Accept-Language without an explicit locale header', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('exercises')
      .set({ name: '杠铃卧推' })
      .where('id', '=', ids.exercise)
      .execute();
    const update = vi.spyOn(ctx.db, 'updateTable');
    const response = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.coachToken))
      .set('Accept-Language', 'zh-TW');
    expect(response.status).toBe(200);
    expect(
      response.body.exercises.find((row: { id: string }) => row.id === ids.exercise).name,
    ).toBe('杠铃卧推');
    expect(update).not.toHaveBeenCalled();
    const stored = await ctx.db
      .selectFrom('users')
      .select('preferred_locale')
      .where('id', '=', ids.coach)
      .executeTakeFirstOrThrow();
    expect(stored.preferred_locale).toBeNull();
  });
  it.each([
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hant', 'zh-Hant'],
    ['en', 'en'],
    ['zh-TW', null],
    ['zh-Hant-TW', null],
    ['ZH-HANT', null],
    ['zh', null],
    ['fr', null],
    ['en-GB', null],
    ['en,zh-Hant', null],
    ['en;q=0.5', null],
    ['*', null],
    ['bad_header', null],
    ['', null],
  ])('accepts only contract values: %s', async (header, expected) => {
    const ctx = await makeContext();
    const update = vi.spyOn(ctx.db, 'updateTable');
    const response = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.coachToken))
      .set('x-mEeTpR-lOcAlE', header)
      .set('Accept-Language', 'zh-TW');
    expect(response.status).toBe(200);
    const stored = await ctx.db
      .selectFrom('users')
      .select('preferred_locale')
      .where('id', '=', ids.coach)
      .executeTakeFirstOrThrow();
    expect(stored.preferred_locale).toBe(expected);
    if (expected === null) expect(update).not.toHaveBeenCalled();
  });
  it('returns 200 and warns when the preference update throws', async () => {
    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const ctx = await makeContext(logger);
    const failure = new Error('preference storage unavailable');
    vi.spyOn(ctx.db, 'updateTable').mockImplementationOnce(() => {
      throw failure;
    });
    const response = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.coachToken))
      .set('X-MeetPR-Locale', 'zh-Hant');
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith({ err: failure }, 'preferred_locale_update_failed');
    });
  });
  it('responds before a pending preference write and only warns on its rejection', async () => {
    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const ctx = await makeContext(logger);
    const executor = ctx.db.getExecutor();
    const execute = executor.executeQuery.bind(executor);
    let rejectUpdate!: (error: Error) => void;
    const pendingUpdate = new Promise<never>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    let updateStarted = false;
    vi.spyOn(executor, 'executeQuery').mockImplementation((query) => {
      if (query.sql.startsWith('update "users"')) {
        updateStarted = true;
        return pendingUpdate;
      }
      return execute(query);
    });
    let response: InMemoryResponse | undefined;
    const finished = request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.coachToken))
      .set('X-MeetPR-Locale', 'zh-Hant')
      .then((value) => {
        response = value;
      });
    const failure = new Error('delayed preference failure');
    try {
      await vi.waitFor(() => {
        expect(updateStarted).toBe(true);
        expect(response?.status).toBe(200);
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rejectUpdate(failure);
      await finished;
    }
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith({ err: failure }, 'preferred_locale_update_failed');
    });
  });
  it('never writes a language from an invalid access token', async () => {
    const ctx = await makeContext();
    const update = vi.spyOn(ctx.db, 'updateTable');
    const response = await request(ctx.app)
      .get('/exercises')
      .set('Authorization', 'Bearer invalid')
      .set('X-MeetPR-Locale', 'zh-Hant');
    expect(response.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });
  it('localizes catalog names and leaves identical coach-created names and storage unchanged', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('exercises')
      .set({ name: '杠铃卧推' })
      .where('id', '=', ids.exercise)
      .execute();
    const custom = await ctx.db
      .insertInto('exercises')
      .values({
        name: '杠铃卧推',
        exercise_type: 'accessory',
        muscle_groups: ['chest'],
        equipment: ['barbell'],
        movement_pattern: [],
        created_by_coach_id: ids.coach,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const response = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.coachToken))
      .set('X-MeetPR-Locale', 'zh-Hant');
    expect(response.status).toBe(200);
    const rows = response.body.exercises as { id: string; name: string }[];
    expect(rows.find((row) => row.id === ids.exercise)?.name).toBe('槓鈴臥推');
    expect(rows.find((row) => row.id === custom.id)?.name).toBe('杠铃卧推');
    const legacy = await request(ctx.app).get('/exercises').set(auth(ctx.coachToken));
    expect(
      (legacy.body.exercises as { name: string }[]).every((row) => row.name === '杠铃卧推'),
    ).toBe(true);
  });
  it('persists changes with one conditional UPDATE and no preceding SELECT', async () => {
    const ctx = await makeContext();
    const queries = vi.spyOn(ctx.db.getExecutor(), 'executeQuery');
    for (const [locale, affected] of [
      ['zh-Hant', 1n],
      ['zh-Hant', 0n],
      ['en', 1n],
    ] as const) {
      queries.mockClear();
      const response = await request(ctx.app)
        .get('/exercises')
        .set(auth(ctx.coachToken))
        .set('X-MeetPR-Locale', locale);
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(queries.mock.calls.some(([query]) => query.sql.startsWith('update "users"'))).toBe(
          true,
        );
      });
      const updates = queries.mock.calls.flatMap(([query], index) =>
        query.sql.startsWith('update "users"') ? [index] : [],
      );
      expect(updates).toHaveLength(1);
      expect(queries.mock.calls.some(([query]) => query.sql.includes('from "users"'))).toBe(false);
      const index = updates[0];
      if (index === undefined) throw new Error('missing preference UPDATE');
      expect(queries.mock.calls[index]?.[0]).toMatchObject({
        sql: 'update "users" set "preferred_locale" = $1 where "id" = $2 and "preferred_locale" is distinct from $3',
        parameters: [locale, ids.coach, locale],
      });
      const result = queries.mock.results[index];
      if (result?.type !== 'return') throw new Error('missing preference UPDATE result');
      expect((await result.value).numAffectedRows).toBe(affected);
    }
    queries.mockClear();
    for (const header of [undefined, 'zh-TW']) {
      const pending = request(ctx.app).get('/exercises').set(auth(ctx.coachToken));
      if (header) pending.set('X-MeetPR-Locale', header);
      expect((await pending).status).toBe(200);
    }
    expect(queries.mock.calls.some(([query]) => query.sql.startsWith('update "users"'))).toBe(
      false,
    );
    const stored = await ctx.db
      .selectFrom('users')
      .select('preferred_locale')
      .where('id', '=', ids.coach)
      .executeTakeFirstOrThrow();
    expect(stored.preferred_locale).toBe('en');
  });
});
