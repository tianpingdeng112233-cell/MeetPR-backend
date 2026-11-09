import jwt from 'jsonwebtoken';
import supertest from 'supertest';
import * as sms from '../src/services/sms';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Insertable, Kysely } from 'kysely';
import { DataType } from 'pg-mem';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/kysely';
import type { Database } from '../src/db/types';
import { makeMigrationDb, runMigration } from './helpers/migrations';
import { request as inMemoryRequest, type InMemoryResponse } from './helpers/inMemoryRequest';

// Use the real HTTP transport normally; the existing injector supports restricted sandboxes.
interface HttpTest extends PromiseLike<InMemoryResponse> {
  set(headers: Record<string, string>): HttpTest;
  send(body: unknown): HttpTest;
}
type HttpClient = Record<'get' | 'post' | 'patch' | 'delete', (path: string) => HttpTest>;
const request: (app: ReturnType<typeof createApp>) => HttpClient =
  process.env.COACH_REVIEWS_TEST_TRANSPORT === 'memory' ? inMemoryRequest : supertest;

const databases: Kysely<Database>[] = [];
const headers =
  '姓名/称呼,网名,性别,抖音号,抖音主页链接,省份,城市,所属场馆/工作室,授课方式,最好总成绩(kg),比赛级别,装备类别,资质认证,执教年限';
const csvRow = (name: string, handle: string, city = '杭州') =>
  `${name},${name}网名,男,${handle},https://www.douyin.com/user/${handle},浙江,${city},无,线上,600,83kg,无装备,认证,3`;
async function context(env: NodeJS.ProcessEnv = {}) {
  const mem = makeMigrationDb();
  // PostgreSQL length(text) counts code points, not JavaScript UTF-16 units.
  mem.public.registerFunction(
    {
      name: 'length',
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => Array.from(value).length,
    },
    true,
  );
  for (const file of ['0001-init-users.sql', '0044-add-admin-role.sql', '0084-coach-reviews.sql'])
    runMigration(mem, `db/migrations/${file}`);
  const { Pool } = mem.adapters.createPg();
  const db = createDb(new Pool());
  databases.push(db);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    JWT_ACCESS_SECRET: 'test-access-secret-long-enough-for-config',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-for-config',
    RATE_LIMIT_MAX: '10000',
    COACH_REVIEWS_ENABLED: 'true',
    COACH_REVIEWS_CONTACT: '管理员联系渠道',
    ...env,
  });
  const app = createApp({ config, db, logger: pino({ level: 'silent' }) });
  const adminId = '11111111-1111-4111-8111-111111111111';
  await db
    .insertInto('users')
    .values({ id: adminId, phone: '13800000000', password_hash: 'disabled', role: 'admin' })
    .execute();
  const admin = {
    Authorization: `Bearer ${jwt.sign({ sub: adminId, role: 'admin' }, config.JWT_ACCESS_SECRET)}`,
  };
  return { app, db, config, admin };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function login(app: ReturnType<typeof createApp>, phone: string) {
  expect((await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status).toBe(
    204,
  );
  const response = await request(app)
    .post('/public/coach-reviews/auth/login')
    .send({ phone, code: '000000' });
  expect(response.status).toBe(200);
  const auth = { Authorization: `Bearer ${response.body.token as string}` };
  expect(
    (
      await request(app)
        .patch('/public/coach-reviews/me')
        .set(auth)
        .send({ nickname: '训练爱好者' })
    ).status,
  ).toBe(200);
  return auth;
}
const coachInput = {
  name: '用户提交教练',
  nickname: '网名',
  gender: '女',
  douyin_handle: 'submitted',
  douyin_url: 'https://www.douyin.com/user/submitted',
  province: '四川',
  city: '成都',
  gyms: ['无'],
  teaching_mode: '线下',
};
const review = {
  overall: 5,
  professionalism: 4,
  communication: 3,
  results: 2,
  value: 1,
  body: '计划安排合理，反馈及时认真。',
};
async function importCoach(
  app: ReturnType<typeof createApp>,
  admin: { Authorization: string },
  name = '教练甲',
  handle = 'coach_a',
) {
  expect(
    (
      await request(app)
        .post('/admin/coach-reviews/import')
        .set(admin)
        .send({ csv: `${headers}\n${csvRow(name, handle)}` })
    ).status,
  ).toBe(200);
  const response = await request(app).get('/public/coach-reviews/coaches');
  const coach = (response.body.coaches as { id: string; name: string }[]).find(
    (c) => c.name === name,
  );
  if (!coach) throw new Error('Expected imported coach');
  return coach.id;
}

async function seedRankedCoach(
  db: Kysely<Database>,
  index: number,
  ratings: number[],
  fields: Partial<Insertable<Database['listed_coaches']>> = {},
) {
  const id = `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
  await db
    .insertInto('listed_coaches')
    .values({
      ...coachInput,
      teaching_mode: '线下',
      id,
      name: `Coach ${String(index)}`,
      douyin_handle: `coach_${String(index)}`,
      status: 'published',
      ...fields,
    })
    .execute();
  for (const [position, overall] of ratings.entries()) {
    const accountId = `44444444-4444-4444-8444-${String(position).padStart(12, '0')}`;
    await db
      .insertInto('coach_review_accounts')
      .values({ id: accountId, phone: `139${String(position).padStart(8, '0')}`, nickname: '学员' })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await db
      .insertInto('coach_reviews')
      .values({ ...review, overall, listed_coach_id: id, account_id: accountId })
      .execute();
  }
  return id;
}

describe('coach reviews HTTP', () => {
  it('B12 most breaks publication ties by name then id and leaves unreviewed coaches last', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { app, db } = await context();
    const z = await seedRankedCoach(db, 1, [5], { name: 'Z reviewed' });
    const aLast = await seedRankedCoach(db, 3, [5], { name: 'A reviewed' });
    const aFirst = await seedRankedCoach(db, 2, [5], { name: 'A reviewed' });
    const emptyZ = await seedRankedCoach(db, 4, [], { name: 'Z unreviewed' });
    const emptyA = await seedRankedCoach(db, 5, [], { name: 'A unreviewed' });
    for (const suffix of ['', '?sort=most']) {
      const response = await request(app).get(`/public/coach-reviews/coaches${suffix}`);
      expect(response.status).toBe(200);
      expect(response.body.coaches.map((coach: { id: string }) => coach.id)).toEqual([
        aFirst,
        aLast,
        z,
        emptyA,
        emptyZ,
      ]);
    }
  });
  it('rejects an unsupported sort without changing the validation envelope', async () => {
    const { app } = await context();
    const response = await request(app).get('/public/coach-reviews/coaches?sort=unknown');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'VALIDATION_ERROR',
      issues: [{ path: ['sort'] }],
    });
  });
  it.each(['most', 'top', 'latest'])(
    'returns the filtered total before pagination for %s',
    async (sort) => {
      const { app, db } = await context();
      const a = await seedRankedCoach(db, 1, [5, 5, 5], { name: 'Match Alpha' });
      const b = await seedRankedCoach(db, 2, [4, 4, 4, 4], { nickname: 'Match Beta' });
      const c = await seedRankedCoach(db, 3, [5, 5], { name: 'Match Gamma' });
      await seedRankedCoach(db, 4, [5, 5, 5], { name: 'Match', province: '浙江' });
      await seedRankedCoach(db, 5, [5, 5, 5], { name: 'Match', city: '绵阳' });
      await seedRankedCoach(db, 6, [5, 5, 5], { name: 'Match', teaching_mode: '线上' });
      await seedRankedCoach(db, 7, [5, 5, 5]);
      await seedRankedCoach(db, 8, [5, 5, 5], { name: 'Match', status: 'hidden' });
      await seedRankedCoach(db, 9, [5, 5, 5], { name: 'Match', status: 'pending' });
      await seedRankedCoach(db, 10, [5, 5, 5], { name: 'Match', status: 'rejected' });
      const query = new URLSearchParams({
        sort,
        province: '四川',
        city: '成都',
        teaching_mode: '线下',
        q: 'Match',
      });
      const list = async () => {
        const response = await request(app).get(
          `/public/coach-reviews/coaches?${query.toString()}`,
        );
        expect(response.status).toBe(200);
        return response.body as { coaches: { id: string }[]; total: number; contact: string };
      };
      const expectedTotal = sort === 'top' ? 2 : 3;
      const all = await list();
      expect(all.total).toBe(expectedTotal);
      expect(all.coaches).toHaveLength(expectedTotal);
      expect(all.coaches.map((coach: { id: string }) => coach.id).sort()).toEqual(
        sort === 'top' ? [a, b] : [a, b, c],
      );
      query.set('limit', '1');
      query.set('offset', '1');
      expect(await list()).toEqual({
        coaches: [all.coaches[1]],
        total: expectedTotal,
        contact: '管理员联系渠道',
      });
      query.set('offset', '100');
      expect(await list()).toEqual({
        coaches: [],
        total: expectedTotal,
        contact: '管理员联系渠道',
      });
      query.set('q', 'No match');
      expect(await list()).toEqual({ coaches: [], total: 0, contact: '管理员联系渠道' });
    },
  );
  it('B12 latest uses first publication, ignores edits, falls back after deletion and puts unreviewed coaches last by listing date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { app, admin } = await context();
    const emptyOld = await importCoach(app, admin, 'A unreviewed', 'empty_old');
    vi.setSystemTime(Date.now() + 1000);
    const emptyNew = await importCoach(app, admin, 'Z unreviewed', 'empty_new');
    vi.setSystemTime(Date.now() + 1000);
    const a = await importCoach(app, admin, 'A reviewed', 'a');
    const b = await importCoach(app, admin, 'B reviewed', 'b');
    const first = await login(app, '13900000001');
    const second = await login(app, '13900000002');
    const publish = async (id: string, auth: { Authorization: string }) => {
      vi.setSystemTime(Date.now() + 1000);
      const response = await request(app)
        .post(`/public/coach-reviews/coaches/${id}/reviews`)
        .set(auth)
        .send(review);
      expect(response.status).toBe(201);
      return response.body.id as string;
    };
    const oldest = await publish(a, first);
    const middle = await publish(b, first);
    const newest = await publish(a, second);
    const ids = async () => {
      const response = await request(app).get('/public/coach-reviews/coaches?sort=latest');
      expect(response.status).toBe(200);
      return response.body.coaches.map((coach: { id: string }) => coach.id) as string[];
    };
    expect(await ids()).toEqual([a, b, emptyNew, emptyOld]);
    vi.setSystemTime(Date.now() + 1000);
    expect(
      (await request(app).patch(`/public/coach-reviews/reviews/${middle}`).set(first).send(review))
        .status,
    ).toBe(200);
    expect(await ids()).toEqual([a, b, emptyNew, emptyOld]);
    expect(
      (await request(app).delete(`/public/coach-reviews/reviews/${newest}`).set(second)).status,
    ).toBe(204);
    expect(await ids()).toEqual([b, a, emptyNew, emptyOld]);
    expect(
      (
        await request(app)
          .post(`/admin/coach-reviews/coaches/${b}/status`)
          .set(admin)
          .send({ status: 'hidden' })
      ).status,
    ).toBe(200);
    expect(await ids()).toEqual([a, emptyNew, emptyOld]);
    expect(
      (await request(app).delete(`/public/coach-reviews/reviews/${oldest}`).set(first)).status,
    ).toBe(204);
    expect(await ids()).toEqual([a, emptyNew, emptyOld]);
  });
  it('B12 top ranks by overall average, then count and id, excluding fewer than three public reviews', async () => {
    const { app, db } = await context();
    const low = await seedRankedCoach(db, 1, [3, 3, 3, 3, 3]);
    const tiedFirst = await seedRankedCoach(db, 2, [4, 4, 4], { name: 'Z coach' });
    const tiedLast = await seedRankedCoach(db, 3, [4, 4, 4], { name: 'A coach' });
    const more = await seedRankedCoach(db, 4, [4, 4, 4, 4]);
    const highest = await seedRankedCoach(db, 5, [5, 5, 4]);
    await seedRankedCoach(db, 6, [5, 5]);
    await seedRankedCoach(db, 7, []);
    await seedRankedCoach(db, 8, [5, 5, 5], { status: 'hidden' });
    const deleted = await seedRankedCoach(db, 9, [5, 5, 5]);
    await db
      .updateTable('coach_reviews')
      .set({ deleted_at: new Date() })
      .where('listed_coach_id', '=', deleted)
      .where('account_id', '=', '44444444-4444-4444-8444-000000000000')
      .execute();
    const response = await request(app).get('/public/coach-reviews/coaches?sort=top');
    expect(response.status).toBe(200);
    expect(response.body.coaches.map((coach: { id: string }) => coach.id)).toEqual([
      highest,
      more,
      tiedFirst,
      tiedLast,
      low,
    ]);
  });
  it('returns the configured public contact verbatim, defaults to empty, and gates the new routes', async () => {
    const contact = '  投诉与下架：请联系管理员\n邮箱：admin@example.test  ';
    const { app } = await context({ COACH_REVIEWS_CONTACT: contact });
    const response = await request(app).get('/public/coach-reviews/config');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ contact });
    const empty = await context({ COACH_REVIEWS_CONTACT: undefined });
    expect(empty.config.COACH_REVIEWS_CONTACT).toBe('');
    expect((await request(empty.app).get('/public/coach-reviews/config')).body).toEqual({
      contact: '',
    });
    const disabled = await context({ COACH_REVIEWS_ENABLED: 'false' });
    for (const path of ['config', 'stats', 'coaches', 'me'])
      expect((await request(disabled.app).get(`/public/coach-reviews/${path}`)).status).toBe(404);
    expect((await request(app).get('/coach-reviews/coaches')).status).toBe(404);
  });
  it('A4 aggregates only published coaches and visible reviews by province and city', async () => {
    const { app, admin } = await context();
    const stats = () => request(app).get('/public/coach-reviews/stats');
    expect((await stats()).status).toBe(200);
    expect((await stats()).body).toEqual({
      coach_count: 0,
      province_count: 0,
      review_count: 0,
      provinces: [],
    });
    const a = await importCoach(app, admin, '教练甲', 'a');
    const b = await importCoach(app, admin, '教练乙', 'b');
    const c = await importCoach(app, admin, '教练丙', 'c');
    await request(app)
      .patch(`/admin/coach-reviews/coaches/${b}`)
      .set(admin)
      .send({ ...coachInput, name: '教练乙', douyin_handle: 'b', province: '浙江', city: '宁波' });
    await request(app)
      .patch(`/admin/coach-reviews/coaches/${c}`)
      .set(admin)
      .send({ ...coachInput, name: '教练丙', douyin_handle: 'c' });
    const author = await login(app, '13900000001');
    const pending = await request(app)
      .post('/public/coach-reviews/coaches')
      .set(author)
      .send(coachInput);
    const rejected = await request(app)
      .post('/public/coach-reviews/coaches')
      .set(author)
      .send({ ...coachInput, douyin_handle: 'rejected' });
    await request(app)
      .post(`/admin/coach-reviews/submissions/${rejected.body.id as string}/decision`)
      .set(admin)
      .send({ action: 'reject' });
    expect(pending.status).toBe(201);
    const reviewA = await request(app)
      .post(`/public/coach-reviews/coaches/${a}/reviews`)
      .set(author)
      .send(review);
    await request(app).post(`/public/coach-reviews/coaches/${c}/reviews`).set(author).send(review);
    const all = (await stats()).body;
    expect(all).toEqual({
      coach_count: 3,
      province_count: 2,
      review_count: 2,
      provinces: expect.arrayContaining([
        {
          province: '浙江',
          coach_count: 2,
          cities: expect.arrayContaining([
            { city: '杭州', coach_count: 1 },
            { city: '宁波', coach_count: 1 },
          ]),
        },
        { province: '四川', coach_count: 1, cities: [{ city: '成都', coach_count: 1 }] },
      ]),
    });
    expect(JSON.stringify(all)).not.toContain('13900000001');
    await request(app)
      .delete(`/public/coach-reviews/reviews/${reviewA.body.id as string}`)
      .set(author);
    expect((await stats()).body.review_count).toBe(1);
    await request(app)
      .post(`/admin/coach-reviews/coaches/${c}/status`)
      .set(admin)
      .send({ status: 'hidden' });
    expect((await stats()).body).toMatchObject({
      coach_count: 2,
      province_count: 1,
      review_count: 0,
    });
    await request(app)
      .post(`/admin/coach-reviews/coaches/${c}/status`)
      .set(admin)
      .send({ status: 'published' });
    expect((await stats()).body).toMatchObject({
      coach_count: 3,
      province_count: 2,
      review_count: 1,
    });
  });
  it('validates nickname and review lengths like PostgreSQL for non-BMP characters', async () => {
    const { app, admin } = await context();
    const id = await importCoach(app, admin),
      auth = await login(app, '13900000001');
    expect(
      (await request(app).patch('/public/coach-reviews/me').set(auth).send({ nickname: '😀' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/public/coach-reviews/me')
          .set(auth)
          .send({ nickname: '😀'.repeat(16) })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch('/public/coach-reviews/me')
          .set(auth)
          .send({ nickname: '😀'.repeat(17) })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/coaches/${id}/reviews`)
          .set(auth)
          .send({ ...review, body: '😀'.repeat(5) })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/coaches/${id}/reviews`)
          .set(auth)
          .send({ ...review, body: '😀'.repeat(1000) })
      ).status,
    ).toBe(201);
    expect(
      (await request(app).get(`/public/coach-reviews/coaches/${id}`)).body.reviews[0].body,
    ).toBe('😀'.repeat(1000));
  });
  it('B1 imports, updates normalized handles, skips example and invalid rows', async () => {
    const { app, admin } = await context();
    expect(
      (
        await request(app)
          .post('/admin/coach-reviews/import')
          .set(admin)
          .send({ csv: `${headers}\n${csvRow('旧名字', 'same')}` })
      ).status,
    ).toBe(200);
    const result = await request(app)
      .post('/admin/coach-reviews/import')
      .set(admin)
      .send({
        csv: [
          headers,
          csvRow('甲', 'a'),
          csvRow('乙', 'b'),
          csvRow('丙', 'c'),
          csvRow('示例教练', 'demo'),
          csvRow('新名字', ' SAME '),
          '缺字段',
        ].join('\n'),
      });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ created: 3, updated: 1, skipped: 2 });
    expect(result.body.skips).toEqual([
      { row: 5, reason: 'example' },
      { row: 7, reason: 'invalid_fields' },
    ]);
    const listed = await request(app).get('/public/coach-reviews/coaches');
    expect(listed.status).toBe(200);
    expect(listed.body.coaches).toHaveLength(4);
    expect(listed.body.contact).toBe('管理员联系渠道');
    expect(JSON.stringify(listed.body)).not.toContain('13800000000');
  });
  it('B4 isolates OTP accounts, enforces cooldown and rejects wrong codes', async () => {
    const { app, admin } = await context();
    const phone = '13912345678';
    expect((await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status).toBe(
      204,
    );
    expect((await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status).toBe(
      429,
    );
    expect(
      (await request(app).post('/public/coach-reviews/auth/login').send({ phone, code: '123456' }))
        .status,
    ).toBe(401);
    const login = await request(app)
      .post('/public/coach-reviews/auth/login')
      .send({ phone, code: '000000' });
    expect(login.status).toBe(200);
    expect(login.body.account.nickname).toBeNull();
    expect(JSON.stringify(login.body)).not.toContain(phone);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    expect(
      (
        await request(app)
          .patch('/public/coach-reviews/me')
          .set(auth)
          .send({ nickname: '认真训练者' })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).patch('/public/coach-reviews/me').set(auth).send({ nickname: phone }))
        .status,
    ).toBe(400);
    expect((await request(app).get('/me').set(auth)).status).toBe(401);
    expect(
      (await request(app).patch('/public/coach-reviews/me').set(admin).send({ nickname: '管理员' }))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/public/coach-reviews/auth/login').send({ phone, code: '000000' }))
        .status,
    ).toBe(401);
  });

  it('B3/B5 counts visible reviews, hides averages below three and preserves edited/deleted history', async () => {
    const { app, admin } = await context();
    const id = await importCoach(app, admin);
    const first = await login(app, '13900000001');
    const second = await login(app, '13900000002');
    const third = await login(app, '13900000003');
    const created = await request(app)
      .post(`/public/coach-reviews/coaches/${id}/reviews`)
      .set(first)
      .send(review);
    expect(created.status).toBe(201);
    const reviewId = created.body.id as string;
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/coaches/${id}/reviews`)
          .set(first)
          .send(review)
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/coaches/${id}/reviews`)
          .set(second)
          .send({ ...review, overall: 4 })
      ).status,
    ).toBe(201);
    let detail = await request(app).get(`/public/coach-reviews/coaches/${id}`);
    expect(detail.body.coach).toMatchObject({ review_count: 2, averages: null });
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/coaches/${id}/reviews`)
          .set(third)
          .send({ ...review, overall: 4 })
      ).status,
    ).toBe(201);
    detail = await request(app).get(`/public/coach-reviews/coaches/${id}`);
    expect(detail.body.coach).toMatchObject({
      review_count: 3,
      averages: { overall: 4.3, professionalism: 4, communication: 3, results: 2, value: 1 },
    });
    expect(
      (
        await request(app)
          .patch(`/public/coach-reviews/reviews/${reviewId}`)
          .set(second)
          .send(review)
      ).status,
    ).toBe(404);
    const edited = await request(app)
      .patch(`/public/coach-reviews/reviews/${reviewId}`)
      .set(first)
      .send({ ...review, overall: 2 });
    expect(edited.status).toBe(200);
    expect(edited.body.edited).toBe(true);
    expect(edited.body.updated_at).toEqual(expect.any(String));
    expect(
      (await request(app).delete(`/public/coach-reviews/reviews/${reviewId}`).set(first)).status,
    ).toBe(204);
    detail = await request(app).get(`/public/coach-reviews/coaches/${id}`);
    expect(detail.body.coach).toMatchObject({ review_count: 2, averages: null });
    expect(detail.body.reviews).toHaveLength(2);
    expect(JSON.stringify(detail.body)).not.toMatch(/1390000000/);
  });
  it('B6 rejects every blocked body before publication and on edits', async () => {
    const { app, admin } = await context();
    const id = await importCoach(app, admin);
    const auth = await login(app, '13900000001');
    expect(
      (
        await request(app)
          .post('/admin/coach-reviews/words')
          .set(admin)
          .send({ word: '测试辱骂词' })
      ).status,
    ).toBe(201);
    for (const [body, reason] of [
      ['联系我 13812345678', 'phone'],
      ['欢迎来联系 wx: abc123', 'wechat'],
      ['欢迎来联系 QQ 12345678', 'qq'],
      ['训练反馈及时，微信号：abc123', 'wechat'],
      ['训练反馈及时，QQ号：12345678', 'qq'],
      ['详情请看 https://example.com', 'link'],
      ['这是一个包含测试辱骂词的正文', 'blocked_word'],
    ]) {
      const response = await request(app)
        .post(`/public/coach-reviews/coaches/${id}/reviews`)
        .set(auth)
        .send({ ...review, body });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'COACH_REVIEW_BLOCKED', reason });
      expect(
        (await request(app).get(`/public/coach-reviews/coaches/${id}`)).body.reviews,
      ).toHaveLength(0);
    }
    const created = await request(app)
      .post(`/public/coach-reviews/coaches/${id}/reviews`)
      .set(auth)
      .send(review);
    expect(created.status).toBe(201);
    expect(
      (
        await request(app)
          .patch(`/public/coach-reviews/reviews/${created.body.id as string}`)
          .set(auth)
          .send({ ...review, body: '这是一个包含测试辱骂词的正文' })
      ).status,
    ).toBe(400);
    for (const body of ['训练反馈及时，微信号：abc123', '训练反馈及时，QQ号：12345678']) {
      expect(
        (
          await request(app)
            .patch(`/public/coach-reviews/reviews/${created.body.id as string}`)
            .set(auth)
            .send({ ...review, body })
        ).status,
      ).toBe(400);
    }
    expect(
      (await request(app).get(`/public/coach-reviews/coaches/${id}`)).body.reviews[0].body,
    ).toBe(review.body);
  });

  it('B8/B9 approves submissions and restores hidden coaches with their original reviews', async () => {
    const { app, admin } = await context();
    const auth = await login(app, '13900000001');
    const submitted = await request(app)
      .post('/public/coach-reviews/coaches')
      .set(auth)
      .send(coachInput);
    expect(submitted.status).toBe(201);
    const id = submitted.body.id as string;
    expect((await request(app).get(`/public/coach-reviews/coaches/${id}`)).status).toBe(404);
    expect((await request(app).get('/public/coach-reviews/coaches')).body.coaches).toHaveLength(0);
    const duplicate = await request(app)
      .post('/public/coach-reviews/coaches')
      .set(auth)
      .send({ ...coachInput, douyin_handle: ' SUBMITTED ' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      listed_coach_id: id,
      url: `/public/coach-reviews/coaches/${id}`,
    });
    expect(
      (await request(app).get('/admin/coach-reviews/submissions').set(admin)).body.coaches,
    ).toHaveLength(1);
    expect(
      (
        await request(app)
          .post(`/admin/coach-reviews/submissions/${id}/decision`)
          .set(admin)
          .send({ action: 'approve' })
      ).status,
    ).toBe(200);
    const created = await request(app)
      .post(`/public/coach-reviews/coaches/${id}/reviews`)
      .set(auth)
      .send(review);
    expect(created.status).toBe(201);
    expect(
      (
        await request(app)
          .patch(`/admin/coach-reviews/coaches/${id}`)
          .set(admin)
          .send({ ...coachInput, name: '已编辑教练' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/admin/coach-reviews/coaches/${id}/status`)
          .set(admin)
          .send({ status: 'hidden' })
      ).status,
    ).toBe(200);
    expect((await request(app).get('/public/coach-reviews/coaches')).body.coaches).toHaveLength(0);
    expect((await request(app).get(`/public/coach-reviews/coaches/${id}`)).status).toBe(404);
    expect(
      (await request(app).get('/public/coach-reviews/me/reviews').set(auth)).body.reviews,
    ).toHaveLength(0);
    expect(
      (
        await request(app)
          .patch(`/public/coach-reviews/reviews/${created.body.id as string}`)
          .set(auth)
          .send(review)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/admin/coach-reviews/coaches/${id}/status`)
          .set(admin)
          .send({ status: 'published' })
      ).status,
    ).toBe(200);
    const restored = await request(app).get(`/public/coach-reviews/coaches/${id}`);
    expect(restored.body.coach).toMatchObject({ name: '已编辑教练', review_count: 1 });
    expect(restored.body.reviews[0]).toMatchObject({ ...review, id: created.body.id });
    const rejected = await request(app)
      .post('/public/coach-reviews/coaches')
      .set(auth)
      .send({ ...coachInput, douyin_handle: 'rejected' });
    expect(
      (
        await request(app)
          .post(`/admin/coach-reviews/submissions/${rejected.body.id as string}/decision`)
          .set(admin)
          .send({ action: 'reject', reason: '资料不足' })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/public/coach-reviews/coaches/${rejected.body.id as string}`))
        .status,
    ).toBe(404);
  });
  it('B7 deduplicates reports, keeps reported reviews visible and closes all on a decision', async () => {
    const { app, admin } = await context();
    const id = await importCoach(app, admin);
    const author = await login(app, '13900000001'),
      reporter = await login(app, '13900000002');
    const created = await request(app)
      .post(`/public/coach-reviews/coaches/${id}/reviews`)
      .set(author)
      .send(review);
    const reviewId = created.body.id as string;
    const report = { reason: 'other', explanation: '请核实训练经历' };
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/reviews/${reviewId}/reports`)
          .set(reporter)
          .send(report)
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/reviews/${reviewId}/reports`)
          .set(reporter)
          .send(report)
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/reviews/${reviewId}/reports`)
          .set(author)
          .send({ reason: 'advertising' })
      ).status,
    ).toBe(201);
    expect(
      (await request(app).get(`/public/coach-reviews/coaches/${id}`)).body.reviews,
    ).toHaveLength(1);
    let queue = await request(app).get('/admin/coach-reviews/reports').set(admin);
    expect(queue.body.reports[0]).toMatchObject({
      review_id: reviewId,
      body: review.body,
      report_count: 2,
      overdue: false,
    });
    expect(
      (
        await request(app)
          .post(`/admin/coach-reviews/reports/${reviewId}/decision`)
          .set(admin)
          .send({ action: 'keep' })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get('/admin/coach-reviews/reports').set(admin)).body.reports,
    ).toHaveLength(0);
    expect(
      (await request(app).get(`/public/coach-reviews/coaches/${id}`)).body.reviews,
    ).toHaveLength(1);
    const third = await login(app, '13900000003');
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/reviews/${reviewId}/reports`)
          .set(third)
          .send(report)
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post(`/admin/coach-reviews/reports/${reviewId}/decision`)
          .set(admin)
          .send({ action: 'delete' })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/public/coach-reviews/coaches/${id}`)).body.coach.review_count,
    ).toBe(0);
    queue = await request(app).get('/admin/coach-reviews/reports').set(admin);
    expect(queue.body.reports).toHaveLength(0);
    expect(
      (await request(app).get(`/public/coach-reviews/coaches/${id}`)).body.reviews,
    ).toHaveLength(0);
  });

  it('B2/B12 filters province/city/mode, searches name/nickname and defaults to most by first publication', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, admin } = await context();
    const a = await importCoach(app, admin, 'A教练', 'a'),
      b = await importCoach(app, admin, 'B教练', 'b'),
      c = await importCoach(app, admin, 'C教练', 'c');
    const auth = await login(app, '13900000001'),
      second = await login(app, '13900000002');
    const aReview = await request(app)
      .post(`/public/coach-reviews/coaches/${a}/reviews`)
      .set(auth)
      .send(review);
    vi.setSystemTime(Date.now() + 1000);
    await request(app).post(`/public/coach-reviews/coaches/${b}/reviews`).set(auth).send(review);
    await request(app).post(`/public/coach-reviews/coaches/${c}/reviews`).set(auth).send(review);
    await request(app).post(`/public/coach-reviews/coaches/${c}/reviews`).set(second).send(review);
    const ids = async () =>
      (
        (await request(app).get('/public/coach-reviews/coaches')).body.coaches as { id: string }[]
      ).map((coach) => coach.id);
    expect(await ids()).toEqual([c, b, a]);
    vi.setSystemTime(Date.now() + 1000);
    expect(
      (
        await request(app)
          .patch(`/public/coach-reviews/reviews/${aReview.body.id as string}`)
          .set(auth)
          .send(review)
      ).status,
    ).toBe(200);
    expect(await ids()).toEqual([c, b, a]);
    const most = await request(app).get('/public/coach-reviews/coaches?sort=most');
    expect(most.status).toBe(200);
    expect(most.body.coaches.map((coach: { id: string }) => coach.id)).toEqual([c, b, a]);
    expect(
      (await request(app).get('/public/coach-reviews/coaches?q=B%E6%95%99%E7%BB%83')).body.coaches,
    ).toHaveLength(1);
    expect(
      (
        await request(app).get(
          '/public/coach-reviews/coaches?q=A%E6%95%99%E7%BB%83%E7%BD%91%E5%90%8D',
        )
      ).body.coaches[0].id,
    ).toBe(a);
    expect(
      (
        await request(app)
          .patch(`/admin/coach-reviews/coaches/${c}`)
          .set(admin)
          .send({ ...coachInput, name: 'C教练', douyin_handle: 'c' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app).get(
          '/public/coach-reviews/coaches?province=%E6%B5%99%E6%B1%9F&teaching_mode=%E7%BA%BF%E4%B8%8A',
        )
      ).body.coaches,
    ).toHaveLength(2);
    expect(
      (
        await request(app).get(
          '/public/coach-reviews/coaches?province=%E6%B5%99%E6%B1%9F&city=%E6%88%90%E9%83%BD',
        )
      ).body.coaches,
    ).toHaveLength(0);
    expect(
      (await request(app).get('/public/coach-reviews/coaches?city=%E6%88%90%E9%83%BD')).body
        .coaches[0].id,
    ).toBe(c);
    const query = new URLSearchParams({
      province: '四川',
      city: '成都',
      teaching_mode: '线下',
      q: 'C教练',
    });
    expect(
      (
        await request(app).get(`/public/coach-reviews/coaches?${query.toString()}`)
      ).body.coaches.map((coach: { id: string }) => coach.id),
    ).toEqual([c]);
    query.set('city', '成');
    expect(
      (await request(app).get(`/public/coach-reviews/coaches?${query.toString()}`)).body.coaches,
    ).toEqual([]);
    query.set('city', '成都市');
    expect(
      (await request(app).get(`/public/coach-reviews/coaches?${query.toString()}`)).body.coaches,
    ).toEqual([]);
  });
  it('uses the shared SMS seam, requires a nickname, locks wrong codes and expires review tokens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T08:00:00Z'));
    vi.spyOn(sms, 'sendOtp').mockResolvedValue('123456');
    const { app, admin } = await context();
    const id = await importCoach(app, admin);
    // The same phone already belongs to an app administrator; the reviewer starts independently.
    const phone = '13800000000';
    expect((await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status).toBe(
      204,
    );
    for (let n = 0; n < 5; n++)
      expect(
        (
          await request(app)
            .post('/public/coach-reviews/auth/login')
            .send({ phone, code: '000000' })
        ).status,
      ).toBe(401);
    expect(
      (await request(app).post('/public/coach-reviews/auth/login').send({ phone, code: '123456' }))
        .status,
    ).toBe(401);
    vi.setSystemTime(Date.now() + 60_001);
    expect((await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status).toBe(
      204,
    );
    const loggedIn = await request(app)
      .post('/public/coach-reviews/auth/login')
      .send({ phone, code: '123456' });
    expect(loggedIn.status).toBe(200);
    const auth = { Authorization: `Bearer ${loggedIn.body.token as string}` };
    expect(loggedIn.body.account.nickname).toBeNull();
    expect((await request(app).get('/public/coach-reviews/me').set(auth)).body).toEqual(
      loggedIn.body.account,
    );
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/coaches/${id}/reviews`)
          .set(auth)
          .send(review)
      ).body.error,
    ).toBe('NICKNAME_REQUIRED');
    for (const path of ['/me', '/plans', '/exercises', '/students/me/reviews'])
      expect((await request(app).get(path).set(auth)).status).toBe(401);
    expect(
      (
        await request(app)
          .post(`/public/coach-reviews/coaches/${id}/reviews`)
          .set(admin)
          .send(review)
      ).status,
    ).toBe(401);
    vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect((await request(app).get('/public/coach-reviews/me').set(auth)).status).toBe(401);
  });
  it('B4 rejects expiry, caps daily sends and limits the source IP', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T08:00:00Z'));
    const { app } = await context();
    const phone = '13900000001';
    expect((await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status).toBe(
      204,
    );
    vi.setSystemTime(Date.now() + 300_001);
    expect(
      (await request(app).post('/public/coach-reviews/auth/login').send({ phone, code: '000000' }))
        .status,
    ).toBe(401);
    for (let n = 0; n < 9; n++) {
      expect(
        (await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status,
      ).toBe(204);
      vi.setSystemTime(Date.now() + 60_001);
    }
    const capped = await request(app).post('/public/coach-reviews/auth/otp').send({ phone });
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe('OTP_DAILY_LIMIT');
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    expect((await request(app).post('/public/coach-reviews/auth/otp').send({ phone })).status).toBe(
      204,
    );
    const other = await context();
    for (let n = 0; n < 20; n++)
      expect(
        (
          await request(other.app)
            .post('/public/coach-reviews/auth/otp')
            .send({ phone: `1390000${String(n).padStart(4, '0')}` })
        ).status,
      ).toBe(204);
    expect(
      (
        await request(other.app)
          .post('/public/coach-reviews/auth/otp')
          .send({ phone: '13900009999' })
      ).status,
    ).toBe(429);
  });
  it('B10 rejects every non-admin on management routes and rechecks the live role', async () => {
    const { app, admin, db, config } = await context();
    const reviewer = await login(app, '13900000001');
    const student = {
      Authorization: `Bearer ${jwt.sign({ sub: 'student', role: 'coached_student' }, config.JWT_ACCESS_SECRET)}`,
    };
    const id = '11111111-1111-4111-8111-111111111111';
    for (const auth of [{}, reviewer, student]) {
      for (const path of ['coaches', 'submissions', 'reports', 'words'])
        expect((await request(app).get(`/admin/coach-reviews/${path}`).set(auth)).status).toBe(403);
      for (const path of [
        'import',
        'words',
        `coaches/${id}/status`,
        `submissions/${id}/decision`,
        `reports/${id}/decision`,
      ])
        expect(
          (await request(app).post(`/admin/coach-reviews/${path}`).set(auth).send({})).status,
        ).toBe(403);
      expect(
        (await request(app).patch(`/admin/coach-reviews/coaches/${id}`).set(auth).send({})).status,
      ).toBe(403);
      expect((await request(app).delete(`/admin/coach-reviews/words/${id}`).set(auth)).status).toBe(
        403,
      );
    }
    await db.updateTable('users').set({ role: 'coach' }).where('id', '=', id).execute();
    expect((await request(app).get('/admin/coach-reviews/coaches').set(admin)).status).toBe(403);
  });
  it('marks an unresolved report overdue only after three days and preserves audit rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, admin } = await context();
    const id = await importCoach(app, admin),
      auth = await login(app, '13900000001');
    const created = await request(app)
      .post(`/public/coach-reviews/coaches/${id}/reviews`)
      .set(auth)
      .send(review);
    const reviewId = created.body.id as string;
    await request(app)
      .post(`/public/coach-reviews/reviews/${reviewId}/reports`)
      .set(auth)
      .send({ reason: 'abuse' });
    vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000 + 1000);
    const queue = await request(app).get('/admin/coach-reviews/reports').set(admin);
    expect(queue.body.reports[0]).toMatchObject({ overdue: true, age_seconds: 259201 });
    expect(
      (await request(app).delete(`/public/coach-reviews/reviews/${reviewId}`).set(auth)).status,
    ).toBe(204);
    expect(
      (await request(app).get('/admin/coach-reviews/reports').set(admin)).body.reports[0],
    ).toMatchObject({ body: review.body, deleted_at: expect.any(String) });
  });
  it('validates ratings, body, nickname and word list maintenance', async () => {
    const { app, admin } = await context();
    const id = await importCoach(app, admin),
      auth = await login(app, '13900000001');
    for (const invalid of [
      { overall: 0 },
      { overall: 6 },
      { overall: 1.5 },
      { professionalism: null },
      { body: '太短' },
      { body: '长'.repeat(1001) },
    ])
      expect(
        (
          await request(app)
            .post(`/public/coach-reviews/coaches/${id}/reviews`)
            .set(auth)
            .send({ ...review, ...invalid })
        ).status,
      ).toBe(400);
    for (const nickname of ['一', '长'.repeat(17), '13812345678', '１３８１２３４５６７８'])
      expect(
        (await request(app).patch('/public/coach-reviews/me').set(auth).send({ nickname })).status,
      ).toBe(400);
    const word = await request(app)
      .post('/admin/coach-reviews/words')
      .set(admin)
      .send({ word: '禁用测试词' });
    expect(
      (await request(app).get('/admin/coach-reviews/words').set(admin)).body.words,
    ).toHaveLength(1);
    expect(
      (
        await request(app)
          .delete(`/admin/coach-reviews/words/${word.body.id as string}`)
          .set(admin)
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get('/admin/coach-reviews/words').set(admin)).body.words,
    ).toHaveLength(0);
  });
});
