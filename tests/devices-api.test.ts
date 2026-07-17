import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext } from './helpers/studentActions';

const validBody = { token: '0123456789abcdef', platform: 'ios' } as const;
type TestContext = Awaited<ReturnType<typeof makeContext>>;
const roleCases: [string, string, (ctx: TestContext) => string][] = [
  ['coach', 'abcdef01', (ctx) => ctx.coachToken],
  ['coached student', 'abcdef02', (ctx) => ctx.traineeToken],
  ['self-train student', 'abcdef03', (ctx) => ctx.selfTrainStudentToken],
];

describe('POST /devices/token', () => {
  it('upserts the same token idempotently for the same user', async () => {
    const ctx = await makeContext();

    const first = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.traineeToken))
      .send(validBody);
    const second = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.traineeToken))
      .send(validBody);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toEqual({ id: expect.any(String) });
    expect(second.body.id).toBe(first.body.id);

    const rows = await ctx.db.selectFrom('device_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.body.id,
      user_id: ids.trainee,
      token: validBody.token,
      platform: 'ios',
    });
  });

  it('migrates token ownership to the currently authenticated user', async () => {
    const ctx = await makeContext();

    const first = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.traineeToken))
      .send(validBody);
    const migrated = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.coachToken))
      .send(validBody);

    expect(first.status).toBe(201);
    expect(migrated.status).toBe(201);
    expect(migrated.body.id).toBe(first.body.id);

    const row = await ctx.db
      .selectFrom('device_tokens')
      .select(['id', 'user_id', 'created_at', 'last_seen_at'])
      .where('token', '=', validBody.token)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ id: first.body.id, user_id: ids.coach });
    // Regression guards: a conflict update must move last_seen_at forward but
    // never rewrite the original registration time.
    expect(row.last_seen_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
    // The registration instant predates the conflict update: re-reading by id
    // must yield the same created_at the first insert produced.
    const secondMigration = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.traineeToken))
      .send(validBody);
    expect(secondMigration.status).toBe(201);
    const afterSecond = await ctx.db
      .selectFrom('device_tokens')
      .select('created_at')
      .where('id', '=', first.body.id)
      .executeTakeFirstOrThrow();
    expect(afterSecond.created_at).toEqual(row.created_at);
  });

  it.each(roleCases)('allows the %s role to register', async (_role, token, tokenFor) => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .post('/devices/token')
      .set(auth(tokenFor(ctx)))
      .send({ token, platform: 'ios' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String) });
  });

  it('accepts uppercase hex and normalizes it for stable uniqueness', async () => {
    const ctx = await makeContext();

    const uppercase = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.traineeToken))
      .send({ token: 'AABBCCDD', platform: 'ios' });
    const lowercase = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.traineeToken))
      .send({ token: 'aabbccdd', platform: 'ios' });

    expect(uppercase.status).toBe(201);
    expect(lowercase.status).toBe(201);
    expect(lowercase.body.id).toBe(uppercase.body.id);
    const rows = await ctx.db.selectFrom('device_tokens').select('token').execute();
    expect(rows).toEqual([{ token: 'aabbccdd' }]);
  });

  it.each([
    ['empty token', { token: '', platform: 'ios' }],
    ['non-hex token', { token: '01xz', platform: 'ios' }],
    ['token over 200 characters', { token: 'a'.repeat(201), platform: 'ios' }],
    ['unsupported platform', { token: 'abcdef', platform: 'android' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .post('/devices/token')
      .set(auth(ctx.traineeToken))
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app).post('/devices/token').send(validBody);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });
});
