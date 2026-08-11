import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AttachmentKind, AttachmentStatus } from '../src/db/types';
import { auth, ids, makeContext, type TestContext } from './helpers/studentActions';
import { makeFakeOss } from './helpers/uploads';

async function seedVideo(
  ctx: TestContext,
  options: {
    ownerId?: string;
    kind?: AttachmentKind;
    status?: AttachmentStatus;
    sourceCoachId?: string | null;
    isUnlinkedExplicit?: boolean;
  } = {},
): Promise<string> {
  const video = await ctx.db
    .insertInto('attachments')
    .values({
      owner_id: options.ownerId ?? ids.trainee,
      kind: options.kind ?? 'set_video',
      oss_key: `tests/video-markers/${randomUUID()}`,
      content_type: 'video/mp4',
      size_bytes: 1024,
      part_count: 1,
      actual_size_bytes: options.status === 'uploading' ? null : 1024,
      status: options.status ?? 'ready',
      source_coach_id: options.sourceCoachId === undefined ? ids.coach : options.sourceCoachId,
      is_unlinked_explicit: options.isUnlinkedExplicit ?? false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return video.id;
}

async function seedMarker(
  ctx: TestContext,
  videoId: string,
  options: {
    coachId?: string;
    timeMs?: number;
    level?: 'info' | 'warn' | 'bad';
    note?: string;
    attachmentId?: string | null;
  } = {},
): Promise<string> {
  const marker = await ctx.db
    .insertInto('video_markers')
    .values({
      video_id: videoId,
      coach_id: options.coachId ?? ids.coach,
      attachment_id: options.attachmentId ?? null,
      time_ms: options.timeMs ?? 1000,
      level: options.level ?? 'info',
      note: options.note ?? '',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return marker.id;
}

async function seedAnnotation(
  ctx: TestContext,
  options: {
    ownerId?: string;
    kind?: AttachmentKind;
    status?: AttachmentStatus;
    /**
     * Which student's conversation the image was sent into. Defaults to the
     * video owner (the provenance-valid case); `null` seeds a never-sent
     * orphan.
     */
    sentToStudentId?: string | null;
  } = {},
): Promise<{ id: string; ossKey: string }> {
  const ossKey = `tests/marker-annotations/${randomUUID()}`;
  const status = options.status ?? 'ready';
  const ownerId = options.ownerId ?? ids.coach;
  const attachment = await ctx.db
    .insertInto('attachments')
    .values({
      owner_id: ownerId,
      kind: options.kind ?? 'chat_image',
      oss_key: ossKey,
      content_type: 'image/png',
      size_bytes: 1024,
      part_count: 1,
      actual_size_bytes: status === 'ready' ? 1024 : null,
      status,
      source_coach_id: ids.coach,
      is_unlinked_explicit: false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const sentTo = options.sentToStudentId === undefined ? ids.trainee : options.sentToStudentId;
  if (sentTo !== null) {
    const conversation =
      (await ctx.db
        .selectFrom('conversations')
        .select('id')
        .where('coach_id', '=', ownerId)
        .where('student_id', '=', sentTo)
        .executeTakeFirst()) ??
      (await ctx.db
        .insertInto('conversations')
        .values({ coach_id: ownerId, student_id: sentTo })
        .returning('id')
        .executeTakeFirstOrThrow());
    const seqRow = await ctx.db
      .selectFrom('messages')
      .select(({ fn }) => fn.max('seq').as('max'))
      .where('conversation_id', '=', conversation.id)
      .executeTakeFirst();
    await ctx.db
      .insertInto('messages')
      .values({
        conversation_id: conversation.id,
        seq: (seqRow?.max ?? 0) + 1,
        sender_id: ownerId,
        kind: 'image',
        body: null,
        attachment_id: attachment.id,
        client_id: randomUUID(),
      })
      .execute();
  }
  return { id: attachment.id, ossKey };
}

async function removeCoachBond(ctx: TestContext, coachId = ids.otherCoach): Promise<void> {
  await ctx.db
    .deleteFrom('bind_requests')
    .where('coach_id', '=', coachId)
    .where('student_id', '=', ids.trainee)
    .execute();
}

describe('shared set-video access gate', () => {
  it('returns 409 for a visible uploading video and 404 for the wrong attachment kind', async () => {
    const ctx = await makeContext();
    const uploadingVideoId = await seedVideo(ctx, { status: 'uploading' });
    const uploadingMarkerId = await seedMarker(ctx, uploadingVideoId);
    const wrongKindId = await seedVideo(ctx, { kind: 'onboarding_video' });
    const wrongKindMarkerId = await seedMarker(ctx, wrongKindId);

    const uploadingResponses = [
      await request(ctx.app).get(`/videos/${uploadingVideoId}/markers`).set(auth(ctx.coachToken)),
      await request(ctx.app)
        .post(`/videos/${uploadingVideoId}/markers`)
        .set(auth(ctx.coachToken))
        .send({ time_ms: 100 }),
      await request(ctx.app)
        .delete(`/videos/${uploadingVideoId}/markers/${uploadingMarkerId}`)
        .set(auth(ctx.coachToken)),
    ];
    for (const response of uploadingResponses) {
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: 'ATTACHMENT_NOT_READY',
        status: 'uploading',
      });
    }

    const wrongKindResponses = [
      await request(ctx.app).get(`/videos/${wrongKindId}/markers`).set(auth(ctx.coachToken)),
      await request(ctx.app)
        .post(`/videos/${wrongKindId}/markers`)
        .set(auth(ctx.coachToken))
        .send({ time_ms: 100 }),
      await request(ctx.app)
        .delete(`/videos/${wrongKindId}/markers/${wrongKindMarkerId}`)
        .set(auth(ctx.coachToken)),
    ];
    for (const response of wrongKindResponses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    }
  });
});

describe('POST /videos/:videoId/viewed', () => {
  it('records the first review time for a provenance-visible bonded coach', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);

    const response = await request(ctx.app)
      .post(`/videos/${videoId}/viewed`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ viewed_at: expect.any(String) });
    const stored = await ctx.db
      .selectFrom('attachments')
      .select('coach_viewed_at')
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow();
    expect(stored.coach_viewed_at).toBeInstanceOf(Date);
    expect(stored.coach_viewed_at?.toISOString()).toBe(response.body.viewed_at);
  });

  it('is idempotent and never replaces the first review time', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    const originalViewedAt = new Date('2026-08-01T08:09:10.123Z');
    await ctx.db
      .updateTable('attachments')
      .set({ coach_viewed_at: originalViewedAt })
      .where('id', '=', videoId)
      .execute();

    const first = await request(ctx.app)
      .post(`/videos/${videoId}/viewed`)
      .set(auth(ctx.coachToken));
    const firstStored = await ctx.db
      .selectFrom('attachments')
      .select('coach_viewed_at')
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow();
    const second = await request(ctx.app)
      .post(`/videos/${videoId}/viewed`)
      .set(auth(ctx.coachToken));
    const secondStored = await ctx.db
      .selectFrom('attachments')
      .select('coach_viewed_at')
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({ viewed_at: originalViewedAt.toISOString() });
    expect(second.body).toEqual({ viewed_at: originalViewedAt.toISOString() });
    expect(firstStored.coach_viewed_at).toEqual(originalViewedAt);
    expect(secondStored.coach_viewed_at).toEqual(originalViewedAt);
  });

  it('enforces coach role, bond, provenance, existence, and ready status', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx, {
      sourceCoachId: null,
      isUnlinkedExplicit: true,
    });

    const student = await request(ctx.app)
      .post(`/videos/${videoId}/viewed`)
      .set(auth(ctx.traineeToken));
    expect(student.status).toBe(403);
    expect(student.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    await removeCoachBond(ctx, ids.coach);
    const unboundCoach = await request(ctx.app)
      .post(`/videos/${videoId}/viewed`)
      .set(auth(ctx.coachToken));
    expect(unboundCoach.status).toBe(403);
    expect(unboundCoach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    const unknown = await request(ctx.app)
      .post(`/videos/${randomUUID()}/viewed`)
      .set(auth(ctx.otherCoachToken));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });

    const hiddenVideoId = await seedVideo(ctx, { sourceCoachId: ids.coach });
    const hidden = await request(ctx.app)
      .post(`/videos/${hiddenVideoId}/viewed`)
      .set(auth(ctx.otherCoachToken));
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });

    const uploadingVideoId = await seedVideo(ctx, {
      status: 'uploading',
      sourceCoachId: ids.otherCoach,
    });
    const notReady = await request(ctx.app)
      .post(`/videos/${uploadingVideoId}/viewed`)
      .set(auth(ctx.otherCoachToken));
    expect(notReady.status).toBe(409);
    expect(notReady.body).toEqual({
      error: 'ATTACHMENT_NOT_READY',
      status: 'uploading',
    });

    const unchanged = await ctx.db
      .selectFrom('attachments')
      .select('coach_viewed_at')
      .where('id', 'in', [videoId, hiddenVideoId, uploadingVideoId])
      .execute();
    expect(unchanged).toHaveLength(3);
    expect(unchanged.every((row) => row.coach_viewed_at === null)).toBe(true);
  });
});

describe('GET /videos/:videoId/markers', () => {
  it('returns markers in time order to the owner and provenance-visible coach', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    await seedMarker(ctx, videoId, {
      timeMs: 3200,
      level: 'warn',
      note: 'Brace',
    });
    await seedMarker(ctx, videoId, {
      timeMs: 800,
      level: 'bad',
      note: 'Depth',
    });

    for (const token of [ctx.traineeToken, ctx.coachToken]) {
      const response = await request(ctx.app).get(`/videos/${videoId}/markers`).set(auth(token));

      expect(response.status).toBe(200);
      expect(response.body.markers).toEqual([
        expect.objectContaining({
          video_id: videoId,
          coach_id: ids.coach,
          attachment_id: null,
          annotation_url: null,
          annotation_expires_in: null,
          time_ms: 800,
          level: 'bad',
          note: 'Depth',
          created_at: expect.any(String),
        }),
        expect.objectContaining({
          video_id: videoId,
          coach_id: ids.coach,
          attachment_id: null,
          annotation_url: null,
          annotation_expires_in: null,
          time_ms: 3200,
          level: 'warn',
          note: 'Brace',
          created_at: expect.any(String),
        }),
      ]);
    }
  });

  it('returns 404 to a second bonded coach when the video belongs to coach A provenance', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    await seedMarker(ctx, videoId);

    const coachA = await request(ctx.app)
      .get(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken));
    const coachB = await request(ctx.app)
      .get(`/videos/${videoId}/markers`)
      .set(auth(ctx.otherCoachToken));

    expect(coachA.status).toBe(200);
    expect(coachB.status).toBe(404);
    expect(coachB.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
  });

  it('rejects a non-bound coach and another student with the video-wall 403 envelope', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx, {
      sourceCoachId: null,
      isUnlinkedExplicit: true,
    });
    await removeCoachBond(ctx);

    for (const token of [ctx.otherCoachToken, ctx.otherStudentToken]) {
      const response = await request(ctx.app).get(`/videos/${videoId}/markers`).set(auth(token));

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    }
  });

  it('returns the attachment 404 envelope for an unknown video', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .get(`/videos/${randomUUID()}/markers`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
  });

  it('lets the student read annotation URLs and signs each annotated marker separately', async () => {
    const oss = makeFakeOss();
    const ctx = await makeContext(undefined, { oss: oss.service });
    const videoId = await seedVideo(ctx);
    const annotation = await seedAnnotation(ctx);
    await seedMarker(ctx, videoId, { timeMs: 100, attachmentId: annotation.id });
    await seedMarker(ctx, videoId, { timeMs: 200, attachmentId: annotation.id });

    const response = await request(ctx.app)
      .get(`/videos/${videoId}/markers`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.markers).toEqual([
      expect.objectContaining({
        attachment_id: annotation.id,
        annotation_url: expect.stringContaining(annotation.ossKey),
        annotation_expires_in: 900,
      }),
      expect.objectContaining({
        attachment_id: annotation.id,
        annotation_url: expect.stringContaining(annotation.ossKey),
        annotation_expires_in: 900,
      }),
    ]);
    expect(oss.calls.signGet).toEqual([
      { key: annotation.ossKey, expiresSeconds: 900 },
      { key: annotation.ossKey, expiresSeconds: 900 },
    ]);
  });
});

describe('POST /videos/:videoId/markers', () => {
  it('lets a bonded coach create a marker and applies snake_case defaults', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);

    const response = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send({ time_ms: 1250 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      video_id: videoId,
      coach_id: ids.coach,
      attachment_id: null,
      annotation_url: null,
      annotation_expires_in: null,
      time_ms: 1250,
      level: 'info',
      note: '',
      created_at: expect.any(String),
    });
    const stored = await ctx.db
      .selectFrom('video_markers')
      .selectAll()
      .where('id', '=', response.body.id as string)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      video_id: videoId,
      coach_id: ids.coach,
      attachment_id: null,
      time_ms: 1250,
      level: 'info',
      note: '',
    });
  });

  it('creates a marker with a ready owned chat image and signs its annotation URL', async () => {
    const oss = makeFakeOss();
    const ctx = await makeContext(undefined, { oss: oss.service });
    const videoId = await seedVideo(ctx);
    const annotation = await seedAnnotation(ctx);

    const response = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send({ time_ms: 1250, attachment_id: annotation.id });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      attachment_id: annotation.id,
      annotation_url: expect.stringContaining(annotation.ossKey),
      annotation_expires_in: 900,
    });
    expect(oss.calls.signGet).toEqual([{ key: annotation.ossKey, expiresSeconds: 900 }]);
    await expect(
      ctx.db
        .selectFrom('video_markers')
        .select('attachment_id')
        .where('id', '=', response.body.id as string)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ attachment_id: annotation.id });
  });

  it('rejects foreign, non-chat-image, missing, and non-ready annotation attachments', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    const foreign = await seedAnnotation(ctx, { ownerId: ids.otherCoach });
    const wrongKind = await seedAnnotation(ctx, { kind: 'set_video' });
    const uploading = await seedAnnotation(ctx, { status: 'uploading' });

    for (const attachmentId of [foreign.id, wrongKind.id, randomUUID()]) {
      const response = await request(ctx.app)
        .post(`/videos/${videoId}/markers`)
        .set(auth(ctx.coachToken))
        .send({ time_ms: 100, attachment_id: attachmentId });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    }

    const notReady = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send({ time_ms: 100, attachment_id: uploading.id });
    expect(notReady.status).toBe(409);
    expect(notReady.body).toEqual({ error: 'ATTACHMENT_NOT_READY', status: 'uploading' });
    expect(await ctx.db.selectFrom('video_markers').select('id').execute()).toEqual([]);
  });

  it('rejects an image from another student\u2019s conversation and a never-sent orphan', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    // Same coach, but the image rode the OTHER student's thread.
    const crossStudent = await seedAnnotation(ctx, { sentToStudentId: ids.otherStudent });
    const orphan = await seedAnnotation(ctx, { sentToStudentId: null });

    for (const attachmentId of [crossStudent.id, orphan.id]) {
      const response = await request(ctx.app)
        .post(`/videos/${videoId}/markers`)
        .set(auth(ctx.coachToken))
        .send({ time_ms: 100, attachment_id: attachmentId });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    }
    expect(await ctx.db.selectFrom('video_markers').select('id').execute()).toEqual([]);
  });

  it('degrades signing failures to plain markers instead of failing the request', async () => {
    const oss = makeFakeOss();
    oss.service.signGetUrl = () => Promise.reject(new Error('oss down'));
    const ctx = await makeContext(undefined, { oss: oss.service });
    const videoId = await seedVideo(ctx);
    const annotation = await seedAnnotation(ctx);

    const created = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send({ time_ms: 1250, attachment_id: annotation.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      attachment_id: annotation.id,
      annotation_url: null,
      annotation_expires_in: null,
    });

    const listed = await request(ctx.app)
      .get(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken));
    expect(listed.status).toBe(200);
    expect(listed.body.markers).toHaveLength(1);
    expect(listed.body.markers[0]).toMatchObject({
      attachment_id: annotation.id,
      annotation_url: null,
    });
  });

  it('enforces the bound-coach-only permission matrix', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx, {
      sourceCoachId: null,
      isUnlinkedExplicit: true,
    });
    await removeCoachBond(ctx);

    const nonBoundCoach = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.otherCoachToken))
      .send({ time_ms: 100 });
    expect(nonBoundCoach.status).toBe(403);
    expect(nonBoundCoach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    for (const token of [ctx.traineeToken, ctx.otherStudentToken]) {
      const student = await request(ctx.app)
        .post(`/videos/${videoId}/markers`)
        .set(auth(token))
        .send({ time_ms: 100 });
      expect(student.status).toBe(403);
      expect(student.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    }

    expect(await ctx.db.selectFrom('video_markers').select('id').execute()).toEqual([]);
  });

  it('lets coach A write its provenance video and hides it from bonded coach B', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);

    const coachA = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send({ time_ms: 100 });
    const coachB = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.otherCoachToken))
      .send({ time_ms: 200 });

    expect(coachA.status).toBe(201);
    expect(coachB.status).toBe(404);
    expect(coachB.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    expect(
      await ctx.db
        .selectFrom('video_markers')
        .select(['coach_id', 'time_ms'])
        .where('video_id', '=', videoId)
        .execute(),
    ).toEqual([{ coach_id: ids.coach, time_ms: 100 }]);
  });

  it('accepts a note at 500 characters and rejects 501 with 422', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    const noteAtLimit = 'n'.repeat(500);

    const accepted = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send({ time_ms: 100, note: noteAtLimit });
    const rejected = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send({ time_ms: 200, note: 'n'.repeat(501) });

    expect(accepted.status).toBe(201);
    expect(accepted.body.note).toBe(noteAtLimit);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toBe('VALIDATION_ERROR');
  });

  it.each([
    [{}, 'missing time_ms'],
    [{ time_ms: -1 }, 'negative time_ms'],
    [{ time_ms: 1.5 }, 'fractional time_ms'],
    [{ time_ms: 2_147_483_648 }, 'time_ms above PostgreSQL INT'],
    [{ time_ms: 0, level: 'urgent' }, 'unknown level'],
    [{ time_ms: 0, note: null }, 'non-string note'],
    [{ time_ms: 0, attachment_id: 'not-a-uuid' }, 'invalid attachment_id'],
    [{ timeMs: 0 }, 'camelCase field'],
    [{ time_ms: 0, extra: true }, 'unknown field'],
  ])('returns 422 for %s (%s)', async (body, _description) => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);

    const response = await request(ctx.app)
      .post(`/videos/${videoId}/markers`)
      .set(auth(ctx.coachToken))
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(expect.any(Array));
  });
});

describe('DELETE /videos/:videoId/markers/:markerId', () => {
  it('deletes an annotated marker without deleting its attachment', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    const annotation = await seedAnnotation(ctx);
    const markerId = await seedMarker(ctx, videoId, { attachmentId: annotation.id });

    const response = await request(ctx.app)
      .delete(`/videos/${videoId}/markers/${markerId}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(204);
    await expect(
      ctx.db
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', annotation.id)
        .executeTakeFirst(),
    ).resolves.toEqual({ id: annotation.id });
  });

  it('allows only the creating coach to delete a marker', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx, {
      sourceCoachId: null,
      isUnlinkedExplicit: true,
    });
    const markerId = await seedMarker(ctx, videoId);

    const otherBoundCoach = await request(ctx.app)
      .delete(`/videos/${videoId}/markers/${markerId}`)
      .set(auth(ctx.otherCoachToken));
    expect(otherBoundCoach.status).toBe(403);
    expect(otherBoundCoach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    await removeCoachBond(ctx);
    const nonBoundCoach = await request(ctx.app)
      .delete(`/videos/${videoId}/markers/${markerId}`)
      .set(auth(ctx.otherCoachToken));
    expect(nonBoundCoach.status).toBe(403);
    expect(nonBoundCoach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    for (const token of [ctx.traineeToken, ctx.otherStudentToken]) {
      const student = await request(ctx.app)
        .delete(`/videos/${videoId}/markers/${markerId}`)
        .set(auth(token));
      expect(student.status).toBe(403);
      expect(student.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    }

    const creator = await request(ctx.app)
      .delete(`/videos/${videoId}/markers/${markerId}`)
      .set(auth(ctx.coachToken));
    expect(creator.status).toBe(204);
    expect(
      await ctx.db
        .selectFrom('video_markers')
        .select('id')
        .where('id', '=', markerId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('hides coach A provenance from bonded coach B even when coach B created the marker', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    const markerId = await seedMarker(ctx, videoId, { coachId: ids.otherCoach });

    const coachB = await request(ctx.app)
      .delete(`/videos/${videoId}/markers/${markerId}`)
      .set(auth(ctx.otherCoachToken));
    expect(coachB.status).toBe(404);
    expect(coachB.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    expect(
      await ctx.db
        .selectFrom('video_markers')
        .select('id')
        .where('id', '=', markerId)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it('rejects the creating coach after its accepted bond is removed', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    const markerId = await seedMarker(ctx, videoId);
    await removeCoachBond(ctx, ids.coach);

    const response = await request(ctx.app)
      .delete(`/videos/${videoId}/markers/${markerId}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    expect(
      await ctx.db
        .selectFrom('video_markers')
        .select('id')
        .where('id', '=', markerId)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it('does not match a marker through a different video path', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    const otherVideoId = await seedVideo(ctx);
    const markerId = await seedMarker(ctx, videoId);

    const response = await request(ctx.app)
      .delete(`/videos/${otherVideoId}/markers/${markerId}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'VIDEO_MARKER_NOT_FOUND' });
    expect(
      await ctx.db
        .selectFrom('video_markers')
        .select('id')
        .where('id', '=', markerId)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it('cascades every marker when the attachment is deleted', async () => {
    const ctx = await makeContext();
    const videoId = await seedVideo(ctx);
    await seedMarker(ctx, videoId, { timeMs: 100 });
    await seedMarker(ctx, videoId, { coachId: ids.otherCoach, timeMs: 200 });

    await ctx.db.deleteFrom('attachments').where('id', '=', videoId).execute();

    expect(
      await ctx.db
        .selectFrom('video_markers')
        .select('id')
        .where('video_id', '=', videoId)
        .execute(),
    ).toEqual([]);
  });
});
