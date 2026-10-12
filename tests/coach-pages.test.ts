import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import supertest from 'supertest';
import { request as inMemoryRequest } from './helpers/inMemoryRequest';
const request =
  process.env.COACH_PAGE_IN_MEMORY === '1'
    ? inMemoryRequest
    : (supertest as unknown as typeof inMemoryRequest);
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import pino from 'pino';
import { config as testConfig } from './helpers/studentActions';
import type { Config } from '../src/config';
import { auth, ids, signToken, makeContext, createPublishedPlan } from './helpers/studentActions';

const adminId = '10000000-0000-4000-8000-000000000099';
const adminAuth = auth(signToken(adminId, 'admin'));
async function context(config: Partial<Config> = {}, afterQuery?: (sql: string) => Promise<void>) {
  const ctx = await makeContext(undefined, { config, ...(afterQuery ? { afterQuery } : {}) });
  await sql`ALTER TABLE users ADD COLUMN email TEXT`.execute(ctx.db);
  await ctx.db
    .insertInto('users')
    .values({ id: adminId, role: 'admin', password_hash: 'test' })
    .execute();
  await sql.raw(readFileSync('db/migrations/0073-coach-pages.sql', 'utf8')).execute(ctx.db);
  return ctx;
}

describe('coach pages', () => {
  it('publishes an approved page and preserves listed_at across expiry, hide and suspension', async () => {
    const ctx = await context();
    const coach = auth(ctx.coachToken);
    const setExpiry = (expires_at: string | null) =>
      request(ctx.app)
        .put(`/admin/coaches/${ids.coach}/subscription`)
        .set(adminAuth)
        .send({ expires_at });
    const action = (verb: string) =>
      request(ctx.app).post(`/admin/coach-pages/${ids.coach}/${verb}`).set(adminAuth).send({});
    expect(
      (
        await request(ctx.app)
          .put('/coach/page')
          .set(coach)
          .send({ slug: 'coach-one', headline: '力量训练' })
      ).status,
    ).toBe(200);
    expect((await request(ctx.app).post('/coach/page/submit').set(coach)).status).toBe(409);
    expect((await setExpiry('2099-01-01T00:00:00Z')).status).toBe(200);
    expect((await request(ctx.app).post('/coach/page/submit').set(coach)).status).toBe(200);
    expect((await action('approve')).status).toBe(200);
    const listed = (await request(ctx.app).get('/coach/page').set(coach)).body.listed_at;
    expect(listed).toEqual(expect.any(String));
    expect((await request(ctx.app).get('/public/coaches/coach-one')).status).toBe(200);
    expect((await request(ctx.app).get('/public/coaches')).body).toMatchObject({
      total: 1,
      coaches: [{ slug: 'coach-one', avatar_url: null }],
    });
    await setExpiry('2000-01-01T00:00:00Z');
    expect((await request(ctx.app).get('/public/coaches/coach-one')).body).toEqual({
      error: 'COACH_PAGE_NOT_FOUND',
    });
    expect((await request(ctx.app).get('/public/coaches')).body.total).toBe(0);
    expect(
      (await request(ctx.app).post('/public/coaches/coach-one/enquiries').send({})).status,
    ).toBe(404);
    await setExpiry('2099-01-01T00:00:00Z');
    expect((await request(ctx.app).get('/public/coaches/coach-one')).status).toBe(200);
    expect((await request(ctx.app).post('/coach/page/hide').set(coach)).status).toBe(200);
    expect((await request(ctx.app).post('/coach/page/show').set(coach)).status).toBe(200);
    expect((await action('suspend')).status).toBe(200);
    expect((await request(ctx.app).post('/coach/page/show').set(coach)).status).toBe(409);
    expect((await action('restore')).status).toBe(200);
    expect((await request(ctx.app).get('/coach/page').set(coach)).body.listed_at).toBe(listed);
    await ctx.db.destroy();
  });
  it('creates an empty draft for a new coach', async () => {
    const ctx = await makeContext();
    await sql.raw(readFileSync('db/migrations/0073-coach-pages.sql', 'utf8')).execute(ctx.db);
    const result = await request(ctx.app).get('/coach/page').set(auth(ctx.coachToken));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'draft', slug: null, headline: '' });
    await ctx.db.destroy();
  });
});

async function publishedContext(
  config: Partial<Config> = {},
  afterQuery?: (sql: string) => Promise<void>,
) {
  const ctx = await context(config, afterQuery);
  await request(ctx.app)
    .put('/coach/page')
    .set(auth(ctx.coachToken))
    .send({ slug: 'coach-one', headline: '力量训练' });
  await request(ctx.app)
    .put(`/admin/coaches/${ids.coach}/subscription`)
    .set(adminAuth)
    .send({ expires_at: '2099-01-01T00:00:00Z' });
  await request(ctx.app).post('/coach/page/submit').set(auth(ctx.coachToken));
  await request(ctx.app).post(`/admin/coach-pages/${ids.coach}/approve`).set(adminAuth);
  return ctx;
}

describe('page guards and moderation', () => {
  it.each(['draft', 'pending', 'hidden', 'suspended', 'no-subscription', 'expired'])(
    'returns identical 404 for %s',
    async (state) => {
      const ctx = await publishedContext();
      if (state === 'no-subscription' || state === 'expired') {
        await request(ctx.app)
          .put(`/admin/coaches/${ids.coach}/subscription`)
          .set(adminAuth)
          .send({ expires_at: state === 'expired' ? '2000-01-01T00:00:00Z' : null });
      } else {
        await sql`UPDATE coach_pages SET status = ${state} WHERE coach_id = ${ids.coach}`.execute(
          ctx.db,
        );
      }
      const get = await request(ctx.app).get('/public/coaches/coach-one');
      const post = await request(ctx.app).post('/public/coaches/coach-one/enquiries').send({});
      expect([get.status, post.status]).toEqual([404, 404]);
      expect(get.body).toEqual({ error: 'COACH_PAGE_NOT_FOUND' });
      expect(post.body).toEqual(get.body);
      expect((await request(ctx.app).get('/public/coaches')).body).toEqual({
        total: 0,
        coaches: [],
      });
      await ctx.db.destroy();
    },
  );

  it('publishes self-description edits immediately and clears the moderation flag', async () => {
    const ctx = await publishedContext();
    expect(
      (
        await request(ctx.app)
          .put('/coach/page')
          .set(auth(ctx.coachToken))
          .send({ headline: '新简介', bio: '新介绍', specialties: ['力量举'] })
      ).status,
    ).toBe(200);
    expect((await request(ctx.app).get('/public/coaches/coach-one')).body).toMatchObject({
      headline: '新简介',
      bio: '新介绍',
      specialties: ['力量举'],
    });
    const pages = (await request(ctx.app).get('/admin/coach-pages').set(adminAuth)).body.pages;
    expect(
      pages.find((p: { coach_id: string }) => p.coach_id === ids.coach).changes_pending_review,
    ).toBe(true);
    expect(
      (await request(ctx.app).post(`/admin/coach-pages/${ids.coach}/mark-reviewed`).set(adminAuth))
        .body.changes_pending_review,
    ).toBe(false);
    await ctx.db.destroy();
  });

  it('rejects malformed, reserved, duplicate and locked slugs; admin can change a locked slug', async () => {
    const ctx = await publishedContext();
    const other = auth(ctx.otherCoachToken);
    for (const slug of [
      'ab',
      'a'.repeat(21),
      '-abc',
      'abc-',
      'ABC',
      'a_b',
      'admin',
      'api',
      'coaches',
      'privacy',
      'www',
      'app',
      'meetpr',
      'login',
      'c',
    ]) {
      expect((await request(ctx.app).put('/coach/page').set(other).send({ slug })).status).toBe(
        400,
      );
    }
    expect(
      (await request(ctx.app).put('/coach/page').set(other).send({ slug: 'coach-one' })).body.error,
    ).toBe('COACH_PAGE_SLUG_TAKEN');
    expect(
      (
        await request(ctx.app)
          .put('/coach/page')
          .set(auth(ctx.coachToken))
          .send({ slug: 'changed' })
      ).body.error,
    ).toBe('COACH_PAGE_SLUG_LOCKED');
    expect(
      (
        await request(ctx.app)
          .put('/coach/page')
          .set(auth(ctx.coachToken))
          .send({ slug: 'coach-one' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app)
          .put(`/admin/coach-pages/${ids.coach}/slug`)
          .set(adminAuth)
          .send({ slug: 'changed' })
      ).status,
    ).toBe(200);
    expect((await request(ctx.app).get('/public/coaches/coach-one')).status).toBe(404);
    expect((await request(ctx.app).get('/public/coaches/changed')).status).toBe(200);
    await ctx.db.destroy();
  });

  it('reports missing submit requirements, requires reject reason and allows a corrected resubmission', async () => {
    const ctx = await context();
    const submit = () => request(ctx.app).post('/coach/page/submit').set(auth(ctx.coachToken));
    expect((await submit()).body.missing).toEqual(['slug', 'headline', 'subscription']);
    await request(ctx.app)
      .put('/coach/page')
      .set(auth(ctx.coachToken))
      .send({ slug: 'coach-one', headline: 'Hello' });
    await request(ctx.app)
      .put(`/admin/coaches/${ids.coach}/subscription`)
      .set(adminAuth)
      .send({ expires_at: '2099-01-01T00:00:00Z' });
    await submit();
    const reject = (reason: string) =>
      request(ctx.app)
        .post(`/admin/coach-pages/${ids.coach}/reject`)
        .set(adminAuth)
        .send({ reason });
    expect((await reject('')).status).toBe(400);
    expect((await reject('请补充简介')).body).toMatchObject({
      status: 'draft',
      rejection_reason: '请补充简介',
    });
    expect((await submit()).body.status).toBe('pending');
    await ctx.db.destroy();
  });

  it('enforces coach auth and the live admin role check while public ignores login state', async () => {
    const ctx = await publishedContext();
    expect((await request(ctx.app).get('/coach/page')).status).toBe(401);
    expect((await request(ctx.app).get('/coach/page').set(auth(ctx.traineeToken))).status).toBe(
      403,
    );
    expect(
      (await request(ctx.app).get('/admin/coach-pages').set(auth(ctx.coachToken))).status,
    ).toBe(403);
    await ctx.db.updateTable('users').set({ role: 'coach' }).where('id', '=', adminId).execute();
    expect((await request(ctx.app).get('/admin/coach-pages').set(adminAuth)).status).toBe(403);
    const publicResponse = await request(ctx.app)
      .get('/public/coaches/coach-one')
      .set('Authorization', 'Bearer invalid');
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers['set-cookie']).toBeUndefined();
    await ctx.db.destroy();
  });
});

const enquiry = {
  name: '访客名字',
  contact: 'private-contact',
  squat_kg: 150,
  bench_kg: 100,
  deadlift_kg: 180,
  goal: '私人目标',
  consent: true,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('coach enquiries', () => {
  it('stores enquiries, silently discards the honeypot, caps the fourth submission and isolates coaches', async () => {
    const ctx = await publishedContext();
    const send = (body = enquiry) =>
      request(ctx.app).post('/public/coaches/coach-one/enquiries').send(body);
    const honeypot = await send({ ...enquiry, website: 'bot' } as typeof enquiry);
    expect(honeypot.status).toBe(201);
    expect((await request(ctx.app).get('/coach/enquiries').set(auth(ctx.coachToken))).body).toEqual(
      { enquiries: [] },
    );
    for (let i = 0; i < 3; i++) {
      const response = await send();
      expect(response.status).toBe(201);
      expect(response.text).toBe('');
    }
    expect((await send()).status).toBe(429);
    const rows = (await request(ctx.app).get('/coach/enquiries').set(auth(ctx.coachToken))).body
      .enquiries;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      name: enquiry.name,
      contact: enquiry.contact,
      status: 'new',
      goal: enquiry.goal,
    });
    expect(rows[0]).not.toHaveProperty('source_hash');
    expect(
      (await request(ctx.app).get('/coach/enquiries').set(auth(ctx.otherCoachToken))).body,
    ).toEqual({ enquiries: [] });
    expect(
      (
        await request(ctx.app)
          .patch(`/coach/enquiries/${String(rows[0].id)}`)
          .set(auth(ctx.otherCoachToken))
          .send({ status: 'closed' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(ctx.app)
          .patch(`/coach/enquiries/${String(rows[0].id)}`)
          .set(auth(ctx.coachToken))
          .send({ status: 'contacted' })
      ).body.status,
    ).toBe('contacted');
    expect(
      (
        await request(ctx.app)
          .patch(`/coach/enquiries/${String(rows[0].id)}`)
          .set(auth(ctx.coachToken))
          .send({ status: 'bad' })
      ).status,
    ).toBe(400);
    await ctx.db.destroy();
  });

  it('requires consent and validates all limits without accepting writable verified stats', async () => {
    const ctx = await publishedContext();
    for (const body of [
      { ...enquiry, consent: false },
      { ...enquiry, name: '' },
      { ...enquiry, name: 'x'.repeat(31) },
      { ...enquiry, contact: 'x'.repeat(101) },
      { ...enquiry, goal: 'x'.repeat(501) },
      { ...enquiry, squat_kg: -1 },
      { ...enquiry, bench_kg: 601 },
      { ...enquiry, deadlift_kg: '100' },
    ]) {
      const r = await request(ctx.app).post('/public/coaches/coach-one/enquiries').send(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('VALIDATION_ERROR');
    }
    for (const body of [
      { headline: 'x'.repeat(31) },
      { bio: 'x'.repeat(501) },
      { specialties: ['x'.repeat(11)] },
      { specialties: ['1', '2', '3', '4', '5', '6'] },
      { verified_stats: { scale: {} } },
    ]) {
      expect(
        (await request(ctx.app).put('/coach/page').set(auth(ctx.coachToken)).send(body)).status,
      ).toBe(400);
    }
    expect(
      (
        await request(ctx.app)
          .post('/public/coaches/coach-one/enquiries')
          .send({ name: 'A', contact: 'B', consent: true })
      ).status,
    ).toBe(201);
    await ctx.db.destroy();
  });

  it.each([
    { locale: 'zh' as const, url: 'https://coach.example.test/' },
    { locale: 'en' as const, url: 'https://coach.example.test/' },
    { locale: 'zh' as const, url: undefined },
    { locale: 'en' as const, url: undefined },
  ])(
    'sends localized mail with optional PUBLIC_BASE_URL: $locale / $url',
    async ({ locale, url }) => {
      const ctx = await publishedContext({
        RESEND_API_KEY: 'test-mail-key',
        EMAIL_FROM: 'test@example.test',
        MAIL_LOCALE: locale,
        ...(url ? { PUBLIC_BASE_URL: url } : {}),
      });
      await ctx.db
        .updateTable('users')
        .set({ email: 'coach@example.test' })
        .where('id', '=', ids.coach)
        .execute();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      expect(
        (await request(ctx.app).post('/public/coaches/coach-one/enquiries').send(enquiry)).status,
      ).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      expect(body.to).toEqual(['coach@example.test']);
      expect(body.text).toContain(
        locale === 'zh' ? '你有一条新的招生申请' : 'You have a new coaching enquiry',
      );
      if (url) {
        expect(body.text).toContain(url);
        expect(body.html).toContain(`href="${url}"`);
      } else {
        expect(body.text).toBe(
          locale === 'zh'
            ? '你有一条新的招生申请，请登录教练网页端查看'
            : 'You have a new coaching enquiry. Please sign in to the coach web app to view it.',
        );
        expect(body.html).not.toContain('href');
        expect(body.text).not.toMatch(/https?:/);
      }
      for (const content of [enquiry.name, enquiry.contact, enquiry.goal, '150', '180'])
        expect(JSON.stringify(body)).not.toContain(content);
      await ctx.db.destroy();
    },
  );

  it.each(['no-email', 'no-config', 'send-failure'])(
    'keeps 201 when mail is unavailable: %s',
    async (mode) => {
      const ctx = await publishedContext(
        mode === 'no-config'
          ? {}
          : { RESEND_API_KEY: 'test-mail-key', EMAIL_FROM: 'test@example.test' },
      );
      if (mode !== 'no-email')
        await ctx.db
          .updateTable('users')
          .set({ email: 'coach@example.test' })
          .where('id', '=', ids.coach)
          .execute();
      const fetchMock = vi.fn().mockRejectedValue(new Error('unavailable'));
      vi.stubGlobal('fetch', fetchMock);
      expect(
        (await request(ctx.app).post('/public/coaches/coach-one/enquiries').send(enquiry)).status,
      ).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(mode === 'send-failure' ? 1 : 0);
      expect(
        (await request(ctx.app).get('/coach/enquiries').set(auth(ctx.coachToken))).body.enquiries,
      ).toHaveLength(1);
      await ctx.db.destroy();
    },
  );
});

describe('verified data wiring and compatibility', () => {
  it('scopes source records to the coach and returns only anonymous public fields', async () => {
    const ctx = await publishedContext();
    const plan = await createPublishedPlan(ctx);
    const otherPlan = await createPublishedPlan(ctx, ids.otherCoach);
    const draft = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft' })
      .where('id', '=', draft.planId)
      .execute();
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-01-01') })
      .where('coach_id', '=', ids.coach)
      .execute();
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-02-01') })
      .where('coach_id', '=', ids.otherCoach)
      .execute();
    let setIndex = 0;
    for (const [exerciseId, weight, date, assumed] of [
      [plan.planExerciseId, '100', '2026-01-01', false],
      [plan.planExerciseId, '125', '2026-10-01', false],
      [plan.planExerciseId, '900', '2026-10-02', true],
      [otherPlan.planExerciseId, '600', '2026-10-02', false],
      [draft.planExerciseId, '700', '2026-10-02', false],
    ] as const) {
      await ctx.db
        .insertInto('set_logs')
        .values({
          student_id: ids.trainee,
          exercise_id: ids.exercise,
          plan_exercise_id: exerciseId,
          set_index: ++setIndex,
          weight_kg: weight,
          reps: 1,
          rpe: '10',
          completed: true,
          assumed,
          logged_date: date,
        })
        .execute();
    }
    await ctx.db
      .insertInto('plan_day_completions')
      .values({ plan_day_id: plan.dayId, student_id: ids.trainee, source: 'manual' })
      .execute();
    await ctx.db
      .insertInto('student_events')
      .values([
        {
          student_id: ids.trainee,
          coach_id: ids.coach,
          event_type: 'pr_e1rm',
          occurred_at: new Date('2026-10-01T00:00:00Z'),
          session_date: '2026-10-01',
          dedup_key: 'one',
        },
        {
          student_id: ids.trainee,
          coach_id: ids.otherCoach,
          event_type: 'pr_e1rm',
          occurred_at: new Date('2026-10-01T00:00:00Z'),
          session_date: '2026-10-01',
          dedup_key: 'two',
        },
      ])
      .execute();
    const created = new Date(Date.now() - 86400000);
    const video = await ctx.db
      .insertInto('attachments')
      .values({
        owner_id: ids.trainee,
        kind: 'set_video',
        oss_key: 'test-video',
        content_type: 'video/mp4',
        size_bytes: 123,
        part_count: 1,
        status: 'ready',
        source_coach_id: ids.coach,
        source_plan_id: plan.planId,
        created_at: created,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('feedback')
      .values([
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          video_id: video.id,
          text: '反馈',
          posted_at: new Date(created.getTime() + 7200000),
        },
        {
          coach_id: ids.otherCoach,
          student_id: ids.trainee,
          video_id: video.id,
          text: '别人的反馈',
          posted_at: new Date(created.getTime() + 60000),
        },
      ])
      .execute();
    await ctx.db
      .insertInto('video_markers')
      .values({
        coach_id: ids.coach,
        video_id: video.id,
        time_ms: 0,
        created_at: new Date(created.getTime() + 3600000),
      })
      .execute();
    const result = await request(ctx.app).get('/public/coaches/coach-one');
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual([
      'accepting_enquiries',
      'avatar_url',
      'bio',
      'data_as_of',
      'display_name',
      'headline',
      'slug',
      'specialties',
      'verified_stats',
    ]);
    const stats = result.body.verified_stats;
    expect(Object.keys(stats).sort()).toEqual(['progress', 'response', 'scale']);
    expect(Object.keys(stats.scale).sort()).toEqual([
      'active_student_count',
      'completed_session_count',
      'total_student_count',
      'training_duration',
    ]);
    expect(stats.scale).toMatchObject({
      active_student_count: 0,
      total_student_count: 1,
      completed_session_count: 1,
    });
    expect(stats.progress).toEqual({
      pr_count: 1,
      students: [{ display_name: '学员 A', lifts: { squat: { change_kg: 25, weeks: 39 } } }],
    });
    expect(stats.response).toEqual({
      median_minutes: 60,
      value: 1,
      unit: 'hours',
      sample_count: 1,
    });
    expect(Object.keys(stats.scale.training_duration).sort()).toEqual(['unit', 'value']);
    for (const row of stats.progress.students) {
      expect(Object.keys(row).sort()).toEqual(['display_name', 'lifts']);
      for (const lift of Object.values(row.lifts))
        expect(Object.keys(lift as object).sort()).toEqual(['change_kg', 'weeks']);
    }
    for (const privateValue of [
      ids.trainee,
      'Trainee One',
      '2026-01-01',
      '2026-10-01',
      video.id,
      plan.planId,
    ])
      expect(JSON.stringify(stats)).not.toContain(privateValue);
    const directory = (await request(ctx.app).get('/public/coaches')).body;
    expect(Object.keys(directory.coaches[0]).sort()).toEqual([
      'active_student_count',
      'avatar_url',
      'display_name',
      'headline',
      'slug',
      'specialties',
    ]);
    expect(directory.coaches[0].active_student_count).toBe(0);
    const preview = (await request(ctx.app).get('/coach/page').set(auth(ctx.coachToken))).body;
    expect(preview.verified_stats).toEqual(stats);
    const admin = (await request(ctx.app).get('/admin/coach-pages').set(adminAuth)).body.pages.find(
      (p: { coach_id: string }) => p.coach_id === ids.coach,
    );
    expect(admin.verified_stats.progress.students[0].lifts.squat).toEqual({
      baseline_kg: 100,
      current_kg: 125,
      change_kg: 25,
      weeks: 39,
    });
    await ctx.db.destroy();
  });

  it('preserves byte-identical existing HTTP responses before and after additive migration and page use', async () => {
    const ctx = await makeContext();
    await sql`ALTER TABLE users ADD COLUMN email TEXT`.execute(ctx.db);
    await ctx.db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', password_hash: 'test' })
      .execute();
    await createPublishedPlan(ctx);
    const read = async () =>
      Promise.all([
        request(ctx.app).get('/coach/students').set(auth(ctx.coachToken)),
        request(ctx.app).get('/me').set(auth(ctx.coachToken)),
        request(ctx.app).get('/admin/overview').set(adminAuth),
      ]);
    const before = await read();
    expect(before.map((r) => r.status)).toEqual([200, 200, 200]);
    await sql.raw(readFileSync('db/migrations/0073-coach-pages.sql', 'utf8')).execute(ctx.db);
    await request(ctx.app).get('/coach/page').set(auth(ctx.coachToken));
    await request(ctx.app)
      .put('/coach/page')
      .set(auth(ctx.coachToken))
      .send({ slug: 'old-coach', headline: 'Still training' });
    await request(ctx.app)
      .put(`/admin/coaches/${ids.coach}/subscription`)
      .set(adminAuth)
      .send({ expires_at: '2000-01-01T00:00:00Z' });
    const after = await read();
    expect(after.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(after.map((r) => r.text)).toEqual(before.map((r) => r.text));
    await ctx.db.destroy();
  });

  it('keeps directory ordering when the earliest coach expires and renews', async () => {
    const ctx = await publishedContext();
    const first = (await request(ctx.app).get('/coach/page').set(auth(ctx.coachToken))).body
      .listed_at;
    await request(ctx.app)
      .put('/coach/page')
      .set(auth(ctx.otherCoachToken))
      .send({ slug: 'second-coach', headline: 'Second' });
    await request(ctx.app)
      .put(`/admin/coaches/${ids.otherCoach}/subscription`)
      .set(adminAuth)
      .send({ expires_at: '2099-01-01T00:00:00Z' });
    await request(ctx.app).post('/coach/page/submit').set(auth(ctx.otherCoachToken));
    await request(ctx.app).post(`/admin/coach-pages/${ids.otherCoach}/approve`).set(adminAuth);
    const slugs = async () => {
      const body = (await request(ctx.app).get('/public/coaches')).body as {
        coaches: { slug: string }[];
      };
      return body.coaches.map((coach) => coach.slug);
    };
    expect(await slugs()).toEqual(['coach-one', 'second-coach']);
    await request(ctx.app)
      .put(`/admin/coaches/${ids.coach}/subscription`)
      .set(adminAuth)
      .send({ expires_at: null });
    expect(await slugs()).toEqual(['second-coach']);
    await request(ctx.app)
      .put(`/admin/coaches/${ids.coach}/subscription`)
      .set(adminAuth)
      .send({ expires_at: '2099-01-01T00:00:00Z' });
    expect(await slugs()).toEqual(['coach-one', 'second-coach']);
    expect(
      (await request(ctx.app).get('/coach/page').set(auth(ctx.coachToken))).body.listed_at,
    ).toBe(first);
    await ctx.db.destroy();
  });

  it('uses a rolling persisted 24-hour quota across app instances and renamed slugs', async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(started));
    const ctx = await publishedContext();
    for (let n = 0; n < 3; n++)
      expect(
        (await request(ctx.app).post('/public/coaches/coach-one/enquiries').send(enquiry)).status,
      ).toBe(201);
    await request(ctx.app)
      .put(`/admin/coach-pages/${ids.coach}/slug`)
      .set(adminAuth)
      .send({ slug: 'renamed' });
    const restartedApp = createApp({
      db: ctx.db,
      config: testConfig,
      logger: pino({ level: 'silent' }),
    });
    expect(
      (await request(restartedApp).post('/public/coaches/renamed/enquiries').send(enquiry)).status,
    ).toBe(429);
    vi.setSystemTime(new Date(started + 86400000));
    expect(
      (await request(ctx.app).post('/public/coaches/renamed/enquiries').send(enquiry)).status,
    ).toBe(201);
    await ctx.db.destroy();
  });
});

describe('legacy coach routes', () => {
  it('keeps the existing dashboard response for authenticated non-coaches', async () => {
    const ctx = await context();
    for (const token of [
      ctx.traineeToken,
      ctx.selfTrainStudentToken,
      signToken(adminId, 'admin'),
    ]) {
      const response = await request(ctx.app).get('/coach/dashboard').set(auth(token));
      expect(response.status).toBe(501);
      expect(response.body).toEqual({ error: 'not_implemented', endpoint: 'GET /coach/dashboard' });
    }
    await ctx.db.destroy();
  });
});

describe('enquiry visibility at insertion', () => {
  it('rejects an enquiry if subscription expires while waiting for the page lock', async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(started);
    let simulateWait = false;
    const ctx = await publishedContext({}, (query) => {
      if (simulateWait && query.includes('for update')) vi.setSystemTime(started + 2000);
      return Promise.resolve();
    });
    await request(ctx.app)
      .put(`/admin/coaches/${ids.coach}/subscription`)
      .set(adminAuth)
      .send({ expires_at: new Date(started + 1000).toISOString() });
    simulateWait = true;
    const response = await request(ctx.app)
      .post('/public/coaches/coach-one/enquiries')
      .send(enquiry);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'COACH_PAGE_NOT_FOUND' });
    expect(
      (await request(ctx.app).get('/coach/enquiries').set(auth(ctx.coachToken))).body.enquiries,
    ).toEqual([]);
    await ctx.db.destroy();
  });
});

describe('coach-controlled visibility', () => {
  it('hides and restores without another review and rejects coach restoration after suspension', async () => {
    const ctx = await publishedContext();
    const coach = auth(ctx.coachToken);
    expect((await request(ctx.app).post('/coach/page/hide').set(coach)).body.status).toBe('hidden');
    expect((await request(ctx.app).get('/public/coaches/coach-one')).status).toBe(404);
    expect((await request(ctx.app).post('/coach/page/show').set(coach)).body.status).toBe(
      'published',
    );
    expect((await request(ctx.app).get('/public/coaches/coach-one')).status).toBe(200);
    await request(ctx.app).post(`/admin/coach-pages/${ids.coach}/suspend`).set(adminAuth);
    expect((await request(ctx.app).post('/coach/page/show').set(coach)).status).toBe(409);
    expect((await request(ctx.app).get('/public/coaches/coach-one')).status).toBe(404);
    await ctx.db.destroy();
  });
});

// Rework round 1: exercise the new configuration through the HTTP boundary.
describe('round 1 public URL configuration', () => {
  it.each([
    { site: undefined, expected: 'https://meetpr.cn/c/coach-one' },
    {
      site: 'https://preview.example.test/cn///',
      expected: 'https://preview.example.test/cn/c/coach-one',
    },
  ])('R1.1 public_url uses the configured site: $site', async ({ site, expected }) => {
    const ctx = await publishedContext(site ? { COACH_SITE_BASE_URL: site } : {});
    const page = await request(ctx.app).get('/coach/page').set(auth(ctx.coachToken));
    expect(page.status).toBe(200);
    expect(page.body.public_url).toBe(expected);
    const admin = await request(ctx.app).get('/admin/coach-pages').set(adminAuth);
    expect(
      admin.body.pages.find((p: { coach_id: string }) => p.coach_id === ids.coach).public_url,
    ).toBe(expected);
    await ctx.db.destroy();
  });
});

describe('round 1 source hash separation', () => {
  it.each([
    { prefix: 'coach-enquiry-source:', status: 429 },
    { prefix: '', status: 201 },
  ])('R1.2 quota recognizes only purpose-prefixed hashes: $prefix', async ({ prefix, status }) => {
    const ctx = await publishedContext({ TRUST_PROXY: 1 });
    const ip = '198.51.100.49';
    const source_hash = createHmac('sha256', testConfig.JWT_ACCESS_SECRET)
      .update(prefix + ip)
      .digest('hex');
    await ctx.db
      .insertInto('coach_enquiries')
      .values(
        [0, 1, 2].map(() => ({
          coach_id: ids.coach,
          name: 'Previous visitor',
          contact: 'fixture',
          source_hash,
          created_at: new Date(),
        })),
      )
      .execute();
    const response = await request(ctx.app)
      .post('/public/coaches/coach-one/enquiries')
      .set('X-Forwarded-For', ip)
      .send(enquiry);
    expect(response.status).toBe(status);
    await ctx.db.destroy();
  });
});

it('R1.3 verified counts use SQL aggregates and preserve scoped totals', async () => {
  const queries: string[] = [];
  const ctx = await publishedContext({}, (query) => {
    queries.push(query);
    return Promise.resolve();
  });
  const own = await createPublishedPlan(ctx);
  const second = await createPublishedPlan(ctx, ids.coach, ids.otherStudent);
  const other = await createPublishedPlan(ctx, ids.otherCoach);
  await ctx.db
    .insertInto('plan_day_completions')
    .values([
      { plan_day_id: own.dayId, student_id: ids.trainee, source: 'manual' },
      { plan_day_id: second.dayId, student_id: ids.otherStudent, source: 'manual' },
      { plan_day_id: other.dayId, student_id: ids.trainee, source: 'manual' },
    ])
    .execute();
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      exercise_id: ids.exercise,
      plan_exercise_id: own.planExerciseId,
      set_index: 1,
      weight_kg: '100',
      reps: 1,
      rpe: '10',
      completed: true,
      logged_date: '2026-01-01',
    })
    .execute();
  await ctx.db
    .insertInto('student_events')
    .values(
      [
        { coach_id: ids.coach, event_type: 'pr_e1rm' as const, dedup_key: 'pr-one' },
        { coach_id: ids.coach, event_type: 'pr_e1rm' as const, dedup_key: 'pr-two' },
        { coach_id: ids.otherCoach, event_type: 'pr_e1rm' as const, dedup_key: 'other-pr' },
        { coach_id: ids.coach, event_type: 'session_completed' as const, dedup_key: 'session' },
      ].map((row) => ({
        ...row,
        student_id: ids.trainee,
        session_date: '2026-01-01',
        occurred_at: new Date('2026-01-01'),
      })),
    )
    .execute();
  queries.length = 0;
  const response = await request(ctx.app).get('/public/coaches/coach-one');
  expect(response.status).toBe(200);
  expect(response.body.verified_stats.scale.completed_session_count).toBe(2);
  expect(response.body.verified_stats.progress.pr_count).toBe(2);
  const counts = queries.filter(
    (q) => q.includes('from "plan_day_completions"') || q.includes('from "student_events"'),
  );
  expect(counts).toHaveLength(2);
  for (const query of counts) expect(query).toMatch(/^select count\(\*\) as "count"/);
  await ctx.db.destroy();
});

describe('round 1 directory scope', () => {
  it('R1.4 empty directory performs no bond queries', async () => {
    const queries: string[] = [];
    const ctx = await context({}, (query) => {
      queries.push(query);
      return Promise.resolve();
    });
    queries.length = 0;
    const response = await request(ctx.app).get('/public/coaches');
    expect(response.body).toEqual({ total: 0, coaches: [] });
    expect(queries.filter((q) => q.includes('from "bind_requests"'))).toEqual([]);
    await ctx.db.destroy();
  });

  it('R1.4 invisible coaches do not broaden candidates or change visible counts', async () => {
    const queries: string[] = [];
    const ctx = await publishedContext({}, (query) => {
      queries.push(query);
      return Promise.resolve();
    });
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-02-01') })
      .where('coach_id', '=', ids.coach)
      .execute();
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-01-01') })
      .where('coach_id', '=', ids.otherCoach)
      .execute();
    const before = await request(ctx.app).get('/public/coaches');
    expect(before.body.coaches).toHaveLength(1);
    expect(before.body.coaches[0].active_student_count).toBe(1);
    await ctx.db
      .insertInto('bind_requests')
      .values({
        coach_id: ids.otherCoach,
        student_id: ids.otherStudent,
        status: 'accepted',
        responded_at: new Date('2026-03-01'),
        expired_at: new Date('2099-01-01'),
      })
      .execute();
    queries.length = 0;
    const after = await request(ctx.app).get('/public/coaches');
    expect(after.body).toEqual(before.body);
    const candidates = queries.find((q) =>
      q.startsWith('select "student_id" from "bind_requests"'),
    );
    expect(candidates).toMatch(/"coach_id" in \(/);
    // Ownership must still consider a competing invisible coach for the selected students.
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-04-01') })
      .where('coach_id', '=', ids.otherCoach)
      .execute();
    expect(
      (await request(ctx.app).get('/public/coaches')).body.coaches[0].active_student_count,
    ).toBe(0);
    await ctx.db.destroy();
  });
});

describe('round 1 headline invariant', () => {
  it.each(['pending', 'published', 'hidden', 'suspended'])(
    'R1.5 %s rejects a blank headline without changing any page fields',
    async (state) => {
      const ctx = state === 'pending' ? await context() : await publishedContext();
      const coach = auth(ctx.coachToken);
      if (state === 'pending') {
        await request(ctx.app)
          .put('/coach/page')
          .set(coach)
          .send({ slug: 'coach-one', headline: 'Original' });
        await request(ctx.app)
          .put(`/admin/coaches/${ids.coach}/subscription`)
          .set(adminAuth)
          .send({ expires_at: '2099-01-01T00:00:00Z' });
        await request(ctx.app).post('/coach/page/submit').set(coach);
      } else if (state === 'hidden') {
        await request(ctx.app).post('/coach/page/hide').set(coach);
      } else if (state === 'suspended') {
        await request(ctx.app).post(`/admin/coach-pages/${ids.coach}/suspend`).set(adminAuth);
      }
      const before = (await request(ctx.app).get('/coach/page').set(coach)).body as Record<
        string,
        unknown
      >;
      expect(before.status).toBe(state);
      const result = await request(ctx.app)
        .put('/coach/page')
        .set(coach)
        .send({ headline: ' \n\t ', bio: 'Must not persist', specialties: ['Must not'] });
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: 'COACH_PAGE_HEADLINE_REQUIRED' });
      const after = (await request(ctx.app).get('/coach/page').set(coach)).body as Record<
        string,
        unknown
      >;
      const { data_as_of: _beforeTime, ...previous } = before;
      const { data_as_of: _afterTime, ...current } = after;
      expect(current).toEqual(previous);
      await ctx.db.destroy();
    },
  );

  it('R1.5 draft may clear its headline', async () => {
    const ctx = await context();
    const coach = auth(ctx.coachToken);
    await request(ctx.app).put('/coach/page').set(coach).send({ headline: 'Original' });
    const result = await request(ctx.app)
      .put('/coach/page')
      .set(coach)
      .send({ headline: ' \n\t ', bio: 'Draft edit' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'draft', headline: '', bio: 'Draft edit' });
    await ctx.db.destroy();
  });
});
