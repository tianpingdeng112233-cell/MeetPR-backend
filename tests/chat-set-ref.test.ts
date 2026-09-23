import type { Request, Response } from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { formatSetRefFirstLine, type SetRefV1 } from '../src/domain/set-ref';
import { conversationsRouter } from '../src/routes/conversations';
import type { OssService } from '../src/services/oss';
import type { TestContext } from './helpers/studentActions';
import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';
import { makeFakeOss, makeUploadsContext } from './helpers/uploads';

const DAY = '2026-07-27';

async function chooseCanonicalCoach(
  ctx: TestContext,
  studentId = ids.trainee,
  coachId = ids.coach,
): Promise<void> {
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
    .where('student_id', '=', studentId)
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
    .where('student_id', '=', studentId)
    .where('coach_id', '=', coachId)
    .execute();
}

async function createConversation(ctx: TestContext, coachId = ids.coach, studentId = ids.trainee) {
  return ctx.db
    .insertInto('conversations')
    .values({ coach_id: coachId, student_id: studentId })
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function createSetLog(ctx: TestContext, studentId = ids.trainee, setIndex = 0) {
  return ctx.db
    .insertInto('set_logs')
    .values({
      student_id: studentId,
      plan_exercise_id: null,
      exercise_id: ids.exercise,
      set_index: setIndex,
      weight_kg: '100.00',
      reps: 5,
      rpe: '8.5',
      completed: true,
      failed: false,
      assumed: false,
      adhoc: true,
      logged_date: DAY,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

function setRef(setLogId: string, overrides: Partial<SetRefV1> = {}): SetRefV1 {
  return {
    v: 1,
    source: 'logged',
    exercise_name: '低杠位深蹲',
    set_number: 1,
    set_total: null,
    weight_kg: '100',
    reps: 5,
    reps_max: null,
    rpe: '8.5',
    day_date: DAY,
    set_log_id: setLogId,
    plan_set_id: null,
    ...overrides,
  };
}

function plannedRef(planSetId: string, overrides: Partial<SetRefV1> = {}): SetRefV1 {
  return {
    v: 1,
    source: 'planned',
    exercise_name: '低杠位深蹲',
    set_number: 1,
    set_total: 3,
    weight_kg: '100',
    reps: 3,
    reps_max: 5,
    rpe: null,
    day_date: DAY,
    set_log_id: null,
    plan_set_id: planSetId,
    ...overrides,
  };
}

async function createPlanSet(ctx: TestContext, studentId = ids.trainee) {
  const plan = await createPublishedPlan(ctx, ids.coach, studentId);
  return ctx.db
    .selectFrom('plan_sets')
    .select(['id', 'set_number'])
    .where('plan_exercise_id', '=', plan.planExerciseId)
    .executeTakeFirstOrThrow();
}

async function createVideo(
  ctx: TestContext,
  setLogId: string | null,
  overrides: {
    ownerId?: string;
    kind?: 'set_video' | 'chat_image';
    status?: 'uploading' | 'ready';
  } = {},
) {
  const ownerId = overrides.ownerId ?? ids.trainee;
  return ctx.db
    .insertInto('attachments')
    .values({
      owner_id: ownerId,
      kind: overrides.kind ?? 'set_video',
      oss_key: `attachments/${ownerId}/${crypto.randomUUID()}.mp4`,
      oss_upload_id: 'set-ref-upload',
      content_type: 'video/mp4',
      size_bytes: 1024,
      filename: 'set.mp4',
      set_log_id: setLogId,
      source_plan_id: null,
      source_coach_id: null,
      is_unlinked_explicit: true,
      part_count: 1,
      actual_size_bytes: 1024,
      status: overrides.status ?? 'ready',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function requestConversationsRouter(
  ctx: TestContext,
  request: {
    method: 'GET' | 'POST';
    url: string;
    user: { id: string; role: 'coach' | 'coached_student' };
    body?: Record<string, unknown>;
    oss?: OssService;
  },
): Promise<{ status: number; body: unknown }> {
  const router = conversationsRouter({
    db: ctx.db,
    logger: pino({ level: 'silent' }),
    ...(request.oss ? { oss: request.oss } : {}),
  });

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(request.url, 'http://localhost');
    const req = {
      method: request.method,
      url: request.url,
      headers: {},
      body: request.body ?? {},
      query: Object.fromEntries(parsedUrl.searchParams),
      user: request.user,
    } as unknown as Request;
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: unknown) {
        resolve({ status, body: payload });
        return res;
      },
    } as unknown as Response;

    router(req, res, (error?: unknown) => {
      reject(error instanceof Error ? error : new Error('message route did not respond'));
    });
  });
}

describe('POST /conversations/:id/messages set_ref', () => {
  it('stores the frozen snapshot/body verbatim and enforces student-only direction', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const log = await createSetLog(ctx);
    const snapshot = setRef(log.id, {
      set_total: 3,
      weight_kg: '0.29',
      reps: 0,
      rpe: '10',
    });
    const firstLine = formatSetRefFirstLine(snapshot);
    const body = `${firstLine}\n膝盖底部有点不稳`;

    const sent = await request(ctx.app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'text', body, set_ref: snapshot, client_id: 'set-ref-valid' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      message: {
        kind: 'text',
        body,
        set_ref: snapshot,
        video_url: null,
        video_expires_in: null,
      },
    });
    expect(
      await ctx.db
        .selectFrom('messages')
        .select(['body', 'set_ref'])
        .where('client_id', '=', 'set-ref-valid')
        .executeTakeFirstOrThrow(),
    ).toEqual({ body, set_ref: snapshot });

    const coachDirection = await request(ctx.app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.coachToken))
      .send({
        kind: 'text',
        body: firstLine,
        set_ref: snapshot,
        client_id: 'coach-set-ref',
      });
    expect(coachDirection.status).toBe(403);
    expect(coachDirection.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    const ordinaryCoachText = await request(ctx.app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'text', body: '普通回复', client_id: 'coach-ordinary-text' });
    expect(ordinaryCoachText.status).toBe(201);
  });

  it('accepts an owned planned set without changing its 1-based number and uses planned preview', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const ownPlanSet = await createPlanSet(ctx);
    expect(ownPlanSet.set_number).toBe(1);
    const snapshot = plannedRef(ownPlanSet.id, { set_number: ownPlanSet.set_number });
    const body = formatSetRefFirstLine(snapshot);
    expect(body).toBe('[训练计划] 低杠位深蹲 第1组/3 计划 100kg×3-5 (2026-07-27)');

    const sent = await requestConversationsRouter(ctx, {
      method: 'POST',
      url: `/${conversation.id}/messages`,
      user: { id: ids.trainee, role: 'coached_student' },
      body: { kind: 'text', body, set_ref: snapshot, client_id: 'planned-valid' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      message: {
        body,
        set_ref: snapshot,
        video_url: null,
        video_expires_in: null,
      },
    });

    const list = await requestConversationsRouter(ctx, {
      method: 'GET',
      url: '/',
      user: { id: ids.trainee, role: 'coached_student' },
    });
    expect(list.body).toMatchObject({
      conversations: [
        {
          id: conversation.id,
          last_message: { preview: '[训练计划]', preview_kind: 'training_plan' },
        },
      ],
    });
  });

  it('rejects foreign or missing planned sets, forged planned body, and any planned video_id', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const ownPlanSet = await createPlanSet(ctx);
    const foreignPlanSet = await createPlanSet(ctx, ids.otherStudent);
    const ownSnapshot = plannedRef(ownPlanSet.id);
    const ownBody = formatSetRefFirstLine(ownSnapshot);
    const missingSnapshot = plannedRef('71000000-0000-4000-8000-000000000099');

    for (const [clientId, snapshot] of [
      ['planned-foreign', plannedRef(foreignPlanSet.id)],
      ['planned-missing', missingSnapshot],
    ] as const) {
      const response = await requestConversationsRouter(ctx, {
        method: 'POST',
        url: `/${conversation.id}/messages`,
        user: { id: ids.trainee, role: 'coached_student' },
        body: {
          kind: 'text',
          body: formatSetRefFirstLine(snapshot),
          set_ref: snapshot,
          client_id: clientId,
        },
      });
      expect(response.status, clientId).toBe(400);
      expect(response.body).toEqual({
        error: 'VALIDATION_ERROR',
        issues: [
          {
            path: ['set_ref', 'plan_set_id'],
            message: 'plan_set_id must identify a planned set on a plan owned by the sender',
          },
        ],
      });
    }

    const forgedBody = await requestConversationsRouter(ctx, {
      method: 'POST',
      url: `/${conversation.id}/messages`,
      user: { id: ids.trainee, role: 'coached_student' },
      body: {
        kind: 'text',
        body: ownBody.replace(' 计划 ', ' '),
        set_ref: ownSnapshot,
        client_id: 'planned-forged-body',
      },
    });
    expect(forgedBody.status).toBe(400);
    expect(forgedBody.body).toMatchObject({ error: 'VALIDATION_ERROR' });

    const withVideo = await requestConversationsRouter(ctx, {
      method: 'POST',
      url: `/${conversation.id}/messages`,
      user: { id: ids.trainee, role: 'coached_student' },
      body: {
        kind: 'text',
        body: ownBody,
        set_ref: ownSnapshot,
        video_id: '80000000-0000-4000-8000-000000000099',
        client_id: 'planned-video',
      },
    });
    expect(withVideo.status).toBe(400);
    expect(withVideo.body).toEqual({
      error: 'VALIDATION_ERROR',
      issues: [
        {
          path: ['video_id'],
          message: 'video_id is not allowed for source=planned',
        },
      ],
    });
  });

  it('rejects strict snapshot/body/source violations but skips all new validation on idempotent hits', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const ownLog = await createSetLog(ctx);
    const foreignLog = await createSetLog(ctx, ids.otherStudent);
    const valid = setRef(ownLog.id);
    const validLine = formatSetRefFirstLine(valid);
    const missingLogRef = setRef('70000000-0000-4000-8000-000000000099');

    for (const [clientId, body, snapshot] of [
      ['mismatch-body', `${validLine}篡改`, valid],
      ['foreign-log', formatSetRefFirstLine(setRef(foreignLog.id)), setRef(foreignLog.id)],
      ['missing-log', formatSetRefFirstLine(missingLogRef), missingLogRef],
      ['invalid-rpe-step', validLine, { ...valid, rpe: '8.3' }],
      ['noncanonical-weight', validLine, { ...valid, weight_kg: '100.10' }],
    ] as const) {
      const response = await request(ctx.app)
        .post(`/conversations/${conversation.id}/messages`)
        .set(auth(ctx.traineeToken))
        .send({ kind: 'text', body, set_ref: snapshot, client_id: clientId });
      expect(response.status, clientId).toBe(400);
      expect(response.body.error, clientId).toBe('VALIDATION_ERROR');
    }

    const videoWithoutCard = await request(ctx.app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({
        kind: 'text',
        body: 'no card',
        video_id: '80000000-0000-4000-8000-000000000099',
        client_id: 'video-without-card',
      });
    expect(videoWithoutCard.status).toBe(400);
    expect(videoWithoutCard.body.error).toBe('VALIDATION_ERROR');

    const first = await request(ctx.app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'text', body: '原始普通消息', client_id: 'payload-agnostic' });
    const retryWithInvalidCard = await request(ctx.app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({
        kind: 'text',
        body: '另一条内容',
        set_ref: { broken: true, rpe: '8.3' },
        video_id: 42,
        client_id: 'payload-agnostic',
      });

    expect(first.status).toBe(201);
    expect(retryWithInvalidCard.status).toBe(200);
    expect(retryWithInvalidCard.body).toEqual(first.body);
  });

  it('pins attachment lock, conversation lock, and insert order inside one transaction', async () => {
    const statements: string[] = [];
    const oss = makeFakeOss();
    const ctx = await makeContext(undefined, {
      oss: oss.service,
      afterQuery: (query) => {
        statements.push(query.toLowerCase().replace(/\s+/g, ' ').trim());
        return Promise.resolve();
      },
    });
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const log = await createSetLog(ctx);
    const snapshot = setRef(log.id);
    const body = formatSetRefFirstLine(snapshot);
    const matching = await createVideo(ctx, log.id);
    statements.length = 0;

    const sent = await requestConversationsRouter(ctx, {
      method: 'POST',
      url: `/${conversation.id}/messages`,
      user: { id: ids.trainee, role: 'coached_student' },
      body: {
        kind: 'text',
        body,
        set_ref: snapshot,
        video_id: matching.id,
        client_id: 'video-lock-order',
      },
      oss: oss.service,
    });
    expect(sent.status).toBe(201);

    const beginIndex = statements.findIndex((query) => query === 'begin');
    const attachmentLockIndex = statements.findIndex(
      (query) => query.includes('from "attachments"') && query.includes('for update'),
    );
    const conversationLockIndex = statements.findIndex(
      (query) => query.includes('from "conversations"') && query.includes('for update'),
    );
    const insertIndex = statements.findIndex((query) => query.startsWith('insert into "messages"'));
    const commitIndex = statements.findIndex((query) => query === 'commit');
    expect(
      [beginIndex, attachmentLockIndex, conversationLockIndex, insertIndex, commitIndex].every(
        (index) => index >= 0,
      ),
      statements.join('\n'),
    ).toBe(true);
    expect(beginIndex).toBeLessThan(attachmentLockIndex);
    expect(attachmentLockIndex).toBeLessThan(conversationLockIndex);
    expect(conversationLockIndex).toBeLessThan(insertIndex);
    expect(insertIndex).toBeLessThan(commitIndex);
    // pg-mem has no real row-lock mutual exclusion. This pins the production SQL
    // and same-transaction ordering; only a PostgreSQL integration test can cover real exclusion.
  });

  it('locks and validates a ready same-set video, signs it, and rejects every mismatch', async () => {
    const ctx = await makeUploadsContext();
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const log = await createSetLog(ctx);
    const otherLog = await createSetLog(ctx, ids.trainee, 1);
    const snapshot = setRef(log.id);
    const body = formatSetRefFirstLine(snapshot);
    const matching = await createVideo(ctx, log.id);

    const sent = await request(ctx.app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({
        kind: 'text',
        body,
        set_ref: snapshot,
        video_id: matching.id,
        client_id: 'video-valid',
      });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      message: {
        set_ref: snapshot,
        video_url: expect.stringContaining('https://fake-oss.invalid/'),
        video_expires_in: 900,
      },
    });
    expect(sent.body.message).not.toHaveProperty('video_id');

    const invalidVideos = [
      await createVideo(ctx, otherLog.id),
      await createVideo(ctx, log.id, { ownerId: ids.coach }),
      await createVideo(ctx, log.id, { kind: 'chat_image' }),
      await createVideo(ctx, log.id, { status: 'uploading' }),
    ];
    const invalidVideoIds = [
      ...invalidVideos.map((video) => video.id),
      '80000000-0000-4000-8000-000000000099',
    ];
    for (const [index, videoId] of invalidVideoIds.entries()) {
      const response = await request(ctx.app)
        .post(`/conversations/${conversation.id}/messages`)
        .set(auth(ctx.traineeToken))
        .send({
          kind: 'text',
          body,
          set_ref: snapshot,
          video_id: videoId,
          client_id: `video-invalid-${String(index)}`,
        });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'CHAT_INVALID_ATTACHMENT' });
    }

    const deletion = await request(ctx.app)
      .delete(`/uploads/${matching.id}`)
      .set(auth(ctx.traineeToken));
    expect(deletion.status).toBe(204);
    const afterDeletion = await request(ctx.app)
      .get(`/conversations/${conversation.id}/messages`)
      .set(auth(ctx.coachToken));
    expect(afterDeletion.body).toMatchObject({
      messages: [{ set_ref: snapshot, video_url: null, video_expires_in: null }],
    });
  });

  it('signs one URL per unique video key when multiple messages reuse the same video', async () => {
    const ctx = await makeUploadsContext();
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const log = await createSetLog(ctx);
    const snapshot = setRef(log.id);
    const video = await createVideo(ctx, log.id);

    await ctx.db
      .insertInto('messages')
      .values(
        [1, 2].map((seq) => ({
          conversation_id: conversation.id,
          seq,
          sender_id: ids.trainee,
          kind: 'text' as const,
          body: formatSetRefFirstLine(snapshot),
          attachment_id: null,
          set_ref: snapshot,
          video_id: video.id,
          client_id: `reused-video-${String(seq)}`,
        })),
      )
      .execute();
    ctx.oss.calls.signGet.length = 0;

    const response = await requestConversationsRouter(ctx, {
      method: 'GET',
      url: `/${conversation.id}/messages`,
      user: { id: ids.coach, role: 'coach' },
      oss: ctx.oss.service,
    });

    expect(response.status).toBe(200);
    expect(
      (response.body as { messages: { video_url: string | null }[] }).messages.map(
        (message) => message.video_url,
      ),
    ).toEqual([
      expect.stringContaining('https://fake-oss.invalid/'),
      expect.stringContaining('https://fake-oss.invalid/'),
    ]);
    expect(ctx.oss.calls.signGet).toHaveLength(1);
  });

  it('returns both video wire fields null without OSS and keeps the card after video deletion', async () => {
    const statements: string[] = [];
    const ctx = await makeContext(undefined, {
      afterQuery: (query) => {
        statements.push(query.toLowerCase());
        return Promise.resolve();
      },
    });
    await chooseCanonicalCoach(ctx);
    const conversation = await createConversation(ctx);
    const log = await createSetLog(ctx);
    const snapshot = setRef(log.id);
    const video = await createVideo(ctx, log.id);

    const sent = await requestConversationsRouter(ctx, {
      method: 'POST',
      url: `/${conversation.id}/messages`,
      user: { id: ids.trainee, role: 'coached_student' },
      body: {
        kind: 'text',
        body: formatSetRefFirstLine(snapshot),
        set_ref: snapshot,
        video_id: video.id,
        client_id: 'video-no-oss',
      },
    });
    expect(sent.body).toMatchObject({
      message: { set_ref: snapshot, video_url: null, video_expires_in: null },
    });

    // Pin the no-OSS short-circuit while the video row still exists: with a live video_id the
    // only thing stopping an attachment/OSS-key lookup is the short-circuit itself. Resetting
    // the log only after the FK is cleared (as this test originally did) proves nothing — an
    // empty id set skips the query anyway.
    statements.length = 0;
    const listedWithVideo = await requestConversationsRouter(ctx, {
      method: 'GET',
      url: `/${conversation.id}/messages`,
      user: { id: ids.trainee, role: 'coached_student' },
    });
    expect(listedWithVideo.body).toMatchObject({
      messages: [{ set_ref: snapshot, video_url: null, video_expires_in: null }],
    });
    expect(statements.filter((sql) => sql.includes('oss_key'))).toHaveLength(0);

    await ctx.db.deleteFrom('attachments').where('id', '=', video.id).execute();
    statements.length = 0;
    const listed = await requestConversationsRouter(ctx, {
      method: 'GET',
      url: `/${conversation.id}/messages`,
      user: { id: ids.trainee, role: 'coached_student' },
    });
    expect(listed.body).toMatchObject({
      messages: [{ set_ref: snapshot, video_url: null, video_expires_in: null }],
    });
    expect(
      await ctx.db
        .selectFrom('messages')
        .select(['set_ref', 'video_id'])
        .where('client_id', '=', 'video-no-oss')
        .executeTakeFirstOrThrow(),
    ).toEqual({ set_ref: snapshot, video_id: null });
    expect(statements.some((query) => query.includes('attachments'))).toBe(false);
  });
});

describe('set_ref visibility matrix: student / current coach / former coach', () => {
  it('does not let hidden cards flip has_more for a former coach', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    const former = await createConversation(ctx, ids.otherCoach, ids.trainee);
    const log = await createSetLog(ctx);
    const snapshot = setRef(log.id);

    await ctx.db
      .insertInto('messages')
      .values(
        [1, 2, 3, 4].map((seq) => {
          const hidden = seq % 2 === 0;
          return {
            conversation_id: former.id,
            seq,
            sender_id: ids.trainee,
            kind: 'text' as const,
            body: hidden ? formatSetRefFirstLine(snapshot) : `visible-${String(seq)}`,
            attachment_id: null,
            set_ref: hidden ? snapshot : null,
            video_id: null,
            client_id: `has-more-${String(seq)}`,
          };
        }),
      )
      .execute();

    const response = await requestConversationsRouter(ctx, {
      method: 'GET',
      url: `/${former.id}/messages?limit=2`,
      user: { id: ids.otherCoach, role: 'coach' },
    });

    expect(response.status).toBe(200);
    expect(
      (response.body as { messages: { seq: number }[] }).messages.map((message) => message.seq),
    ).toEqual([3, 1]);
    expect((response.body as { meta: { has_more: boolean } }).meta.has_more).toBe(false);
  });

  it('closes all nine read-side surfaces while preserving monotonic sparse pagination', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    const current = await createConversation(ctx, ids.coach, ids.trainee);
    const former = await createConversation(ctx, ids.otherCoach, ids.trainee);
    const log = await createSetLog(ctx);
    const snapshot = setRef(log.id);
    const base = new Date('2026-07-27T10:00:00.000Z');

    const formerRows = await ctx.db
      .insertInto('messages')
      .values([
        {
          conversation_id: former.id,
          seq: 1,
          sender_id: ids.otherCoach,
          kind: 'text',
          body: 'former-visible-1',
          attachment_id: null,
          set_ref: null,
          video_id: null,
          client_id: 'former-1',
          created_at: new Date(base.getTime() + 1_000),
        },
        {
          conversation_id: former.id,
          seq: 2,
          sender_id: ids.trainee,
          kind: 'text',
          body: formatSetRefFirstLine(snapshot),
          attachment_id: null,
          set_ref: snapshot,
          video_id: null,
          client_id: 'former-hidden-2',
          created_at: new Date(base.getTime() + 2_000),
        },
        {
          conversation_id: former.id,
          seq: 3,
          sender_id: ids.trainee,
          kind: 'text',
          body: 'former-visible-3',
          attachment_id: null,
          set_ref: null,
          video_id: null,
          client_id: 'former-3',
          created_at: new Date(base.getTime() + 3_000),
        },
        {
          conversation_id: former.id,
          seq: 5,
          sender_id: ids.trainee,
          kind: 'text',
          body: 'former-visible-5',
          attachment_id: null,
          set_ref: null,
          video_id: null,
          client_id: 'former-5',
          created_at: new Date(base.getTime() + 5_000),
        },
        {
          conversation_id: former.id,
          seq: 6,
          sender_id: ids.trainee,
          kind: 'text',
          body: formatSetRefFirstLine(snapshot),
          attachment_id: null,
          set_ref: snapshot,
          video_id: null,
          client_id: 'former-hidden-6',
          created_at: new Date(base.getTime() + 6_000),
        },
      ])
      .returning(['id', 'seq'])
      .execute();
    await ctx.db
      .updateTable('conversations')
      .set({ last_message_at: new Date(base.getTime() + 6_000) })
      .where('id', '=', former.id)
      .execute();
    await ctx.db
      .insertInto('conversation_reads')
      .values([
        { conversation_id: former.id, user_id: ids.otherCoach, last_read_seq: 2 },
        { conversation_id: former.id, user_id: ids.trainee, last_read_seq: 6 },
      ])
      .execute();

    await ctx.db
      .insertInto('messages')
      .values({
        conversation_id: current.id,
        seq: 1,
        sender_id: ids.trainee,
        kind: 'text',
        body: formatSetRefFirstLine(snapshot),
        attachment_id: null,
        set_ref: snapshot,
        video_id: null,
        client_id: 'current-card',
        created_at: base,
      })
      .execute();

    const matrix = [
      {
        viewer: 'student',
        token: ctx.traineeToken,
        conversationId: former.id,
        expectedSeqs: [6, 5, 3, 2, 1],
      },
      {
        viewer: 'current coach',
        token: ctx.coachToken,
        conversationId: current.id,
        expectedSeqs: [1],
      },
      {
        viewer: 'former coach',
        token: ctx.otherCoachToken,
        conversationId: former.id,
        expectedSeqs: [5, 3, 1],
      },
    ] as const;
    for (const column of matrix) {
      const response = await request(ctx.app)
        .get(`/conversations/${column.conversationId}/messages`)
        .set(auth(column.token));
      expect(response.status, column.viewer).toBe(200);
      expect(
        (response.body as { messages: { seq: number }[] }).messages.map((message) => message.seq),
        column.viewer,
      ).toEqual(column.expectedSeqs);
    }

    const sparse = await request(ctx.app)
      .get(`/conversations/${former.id}/messages?since_seq=1&limit=2`)
      .set(auth(ctx.otherCoachToken));
    const sparseSeqs = (sparse.body as { messages: { seq: number }[] }).messages.map(
      (message) => message.seq,
    );
    expect(sparseSeqs).toEqual([3, 5]);
    expect((sparse.body as { meta: { has_more: boolean } }).meta.has_more).toBe(false);
    expect(new Set(sparseSeqs).size).toBe(sparseSeqs.length);
    expect(
      sparseSeqs.every((seq, index) => index === 0 || seq > (sparseSeqs[index - 1] ?? 0)),
    ).toBe(true);

    const formerList = await request(ctx.app).get('/conversations').set(auth(ctx.otherCoachToken));
    const formerWire = (
      formerList.body as {
        conversations: {
          id: string;
          last_message: { seq: number; preview: string } | null;
          last_message_at: string | null;
          unread_count: number;
          my_last_read: { seq: number } | null;
          other_last_read: { seq: number } | null;
        }[];
      }
    ).conversations.find((conversation) => conversation.id === former.id);
    expect(formerWire).toMatchObject({
      last_message: { seq: 5, preview: 'former-visible-5' },
      last_message_at: new Date(base.getTime() + 5_000).toISOString(),
      unread_count: 2,
      my_last_read: { seq: 1 },
      other_last_read: { seq: 5 },
    });

    const formerMessages = await request(ctx.app)
      .get(`/conversations/${former.id}/messages`)
      .set(auth(ctx.otherCoachToken));
    expect(formerMessages.body).toMatchObject({
      meta: { other_last_read: { seq: 5 } },
    });

    const hidden = formerRows.find((row) => row.seq === 6);
    if (!hidden) throw new Error('missing hidden cursor fixture');
    const rejectedCursor = await request(ctx.app)
      .post(`/conversations/${former.id}/read`)
      .set(auth(ctx.otherCoachToken))
      .send({ message_id: hidden.id });
    expect(rejectedCursor.status).toBe(400);
    expect(rejectedCursor.body).toEqual({ error: 'CHAT_INVALID_CURSOR' });
  });

  it('resolves one coach list per conversation when current and former conversations are mixed', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.otherCoach,
        status: 'accepted',
        responded_at: new Date('2026-03-01T00:00:00.000Z'),
        expired_at: new Date('2027-01-01T00:00:00.000Z'),
      })
      .execute();

    const former = await createConversation(ctx, ids.otherCoach, ids.trainee);
    const current = await createConversation(ctx, ids.otherCoach, ids.otherStudent);
    const traineeLog = await createSetLog(ctx);
    const otherLog = await createSetLog(ctx, ids.otherStudent);
    const formerRef = setRef(traineeLog.id);
    const currentRef = setRef(otherLog.id);

    await ctx.db
      .insertInto('messages')
      .values([
        {
          conversation_id: former.id,
          seq: 1,
          sender_id: ids.trainee,
          kind: 'text',
          body: 'former visible',
          attachment_id: null,
          set_ref: null,
          video_id: null,
          client_id: 'mixed-former-visible',
          created_at: new Date('2026-07-01T00:00:00.000Z'),
        },
        {
          conversation_id: former.id,
          seq: 2,
          sender_id: ids.trainee,
          kind: 'text',
          body: formatSetRefFirstLine(formerRef),
          attachment_id: null,
          set_ref: formerRef,
          video_id: null,
          client_id: 'mixed-former-hidden',
          created_at: new Date('2026-07-04T00:00:00.000Z'),
        },
        {
          conversation_id: current.id,
          seq: 1,
          sender_id: ids.otherStudent,
          kind: 'text',
          body: formatSetRefFirstLine(currentRef),
          attachment_id: null,
          set_ref: currentRef,
          video_id: null,
          client_id: 'mixed-current-card',
          created_at: new Date('2026-07-03T00:00:00.000Z'),
        },
      ])
      .execute();
    await ctx.db
      .updateTable('conversations')
      .set({ last_message_at: new Date('2026-07-04T00:00:00.000Z') })
      .where('id', '=', former.id)
      .execute();
    await ctx.db
      .updateTable('conversations')
      .set({ last_message_at: new Date('2026-07-03T00:00:00.000Z') })
      .where('id', '=', current.id)
      .execute();

    const response = await request(ctx.app).get('/conversations').set(auth(ctx.otherCoachToken));
    const conversations = (
      response.body as {
        conversations: {
          id: string;
          last_message: { preview: string } | null;
          last_message_at: string | null;
        }[];
      }
    ).conversations;

    expect(conversations.map((conversation) => conversation.id)).toEqual([current.id, former.id]);
    expect(conversations.find((conversation) => conversation.id === current.id)).toMatchObject({
      last_message: { preview: '[训练分享]', preview_kind: 'training_share' },
      last_message_at: '2026-07-03T00:00:00.000Z',
    });
    expect(conversations.find((conversation) => conversation.id === former.id)).toMatchObject({
      last_message: { preview: 'former visible', preview_kind: 'text' },
      last_message_at: '2026-07-01T00:00:00.000Z',
    });
  });
});
