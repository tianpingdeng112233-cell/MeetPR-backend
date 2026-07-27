import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AttachmentKind, AttachmentStatus } from '../src/db/types';
import { auth, ids, makeContext, type TestContext } from './helpers/studentActions';

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
  } = {},
): Promise<string> {
  const marker = await ctx.db
    .insertInto('video_markers')
    .values({
      video_id: videoId,
      coach_id: options.coachId ?? ids.coach,
      time_ms: options.timeMs ?? 1000,
      level: options.level ?? 'info',
      note: options.note ?? '',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return marker.id;
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
          time_ms: 800,
          level: 'bad',
          note: 'Depth',
          created_at: expect.any(String),
        }),
        expect.objectContaining({
          video_id: videoId,
          coach_id: ids.coach,
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
      time_ms: 1250,
      level: 'info',
      note: '',
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
