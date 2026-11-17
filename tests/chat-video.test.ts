import { describe, expect, it } from 'vitest';

import { request } from './helpers/inMemoryRequest';
import { auth, ids } from './helpers/studentActions';
import { createReadyAttachment, makeUploadsContext, type UploadsContext } from './helpers/uploads';

async function conversation(ctx: UploadsContext): Promise<string> {
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-01-01') })
    .where('student_id', '=', ids.trainee)
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-02-01') })
    .where('student_id', '=', ids.trainee)
    .where('coach_id', '=', ids.coach)
    .execute();
  const opened = await request(ctx.app)
    .post('/conversations')
    .set(auth(ctx.traineeToken))
    .send({ other_user_id: ids.coach });
  expect(opened.status).toBe(201);
  return (opened.body as { conversation: { id: string } }).conversation.id;
}

async function video(ctx: UploadsContext, token = ctx.traineeToken): Promise<string> {
  return createReadyAttachment(ctx, token, {
    kind: 'chat_video',
    content_type: 'video/mp4',
    size_bytes: 2 * 1024 * 1024,
    filename: 'chat.mp4',
  });
}

describe('standalone chat video', () => {
  it('never delivers a video whose deletion won a concurrent send race', async () => {
    const ctx = await makeUploadsContext();
    const id = await conversation(ctx);
    const attachment = await video(ctx);
    const [sent, removed] = await Promise.all([
      request(ctx.app)
        .post(`/conversations/${id}/messages`)
        .set(auth(ctx.traineeToken))
        .send({ kind: 'text', body: '[视频]', video_id: attachment, client_id: 'racing-video' }),
      request(ctx.app).delete(`/uploads/${attachment}`).set(auth(ctx.traineeToken)),
    ]);
    const read = await request(ctx.app)
      .get(`/conversations/${id}/messages`)
      .set(auth(ctx.coachToken));
    if (sent.status === 201) {
      expect(removed.status).toBe(409);
      expect(ctx.oss.calls.delete).toHaveLength(0);
      expect(read.body).toMatchObject({
        messages: [{ video_id: attachment, video_url: expect.any(String) }],
      });
    } else {
      expect(sent.status).toBe(400);
      expect(removed.status).toBe(204);
      expect(read.body).toMatchObject({ messages: [] });
    }
  });

  it('enforces file gates and rejects wrong owner, kind, readiness, role, and binding', async () => {
    const ctx = await makeUploadsContext();
    const id = await conversation(ctx);
    const ready = await video(ctx);
    const coachOwned = await video(ctx, ctx.coachToken);
    const wrongKind = await createReadyAttachment(ctx, ctx.traineeToken);
    const uploading = await request(ctx.app)
      .post('/uploads/initiate')
      .set(auth(ctx.traineeToken))
      .send({
        kind: 'chat_video',
        content_type: 'video/quicktime',
        size_bytes: 1024,
        part_count: 1,
      });
    expect(uploading.status).toBe(201);
    const uploadingId = (uploading.body as { attachment_id: string }).attachment_id;
    for (const [index, attachment] of [
      coachOwned,
      wrongKind,
      uploadingId,
      '90000000-0000-4000-8000-000000000001',
    ].entries()) {
      const result = await request(ctx.app)
        .post(`/conversations/${id}/messages`)
        .set(auth(ctx.traineeToken))
        .send({
          kind: 'text',
          body: '[视频]',
          video_id: attachment,
          client_id: `invalid-${String(index)}`,
        });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'CHAT_INVALID_ATTACHMENT' });
    }
    const coachSend = await request(ctx.app)
      .post(`/conversations/${id}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'text', body: '[视频]', video_id: coachOwned, client_id: 'coach-video' });
    expect(coachSend.status).toBe(403);
    for (const [contentType, size, error] of [
      ['image/jpeg', 1024, 'UPLOAD_CONTENT_TYPE_MISMATCH'],
      ['video/mp4', 200 * 1024 * 1024 + 1, 'UPLOAD_TOO_LARGE'],
    ] as const) {
      const result = await request(ctx.app)
        .post('/uploads/initiate')
        .set(auth(ctx.traineeToken))
        .send({ kind: 'chat_video', content_type: contentType, size_bytes: size, part_count: 1 });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error });
    }
    const invalidLink = await request(ctx.app)
      .post('/uploads/initiate')
      .set(auth(ctx.traineeToken))
      .send({
        kind: 'chat_video',
        content_type: 'video/mp4',
        size_bytes: 1024,
        part_count: 1,
        set_log_id: ids.trainee,
      });
    expect(invalidLink.status).toBe(400);
    await ctx.db
      .updateTable('bind_requests')
      .set({ status: 'rejected' })
      .where('student_id', '=', ids.trainee)
      .execute();
    const unbound = await request(ctx.app)
      .post(`/conversations/${id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'text', body: '[视频]', video_id: ready, client_id: 'unbound-video' });
    expect(unbound.status).toBe(403);
    expect(unbound.body).toEqual({ error: 'CHAT_BIND_REQUIRED' });
  });

  it('retries idempotently before inspecting the replacement attachment and renews an older message in place', async () => {
    const ctx = await makeUploadsContext();
    const id = await conversation(ctx);
    const attachment = await video(ctx);
    const payload = {
      kind: 'text',
      body: '[视频]',
      video_id: attachment,
      client_id: 'retry-video',
    };
    const sent = await request(ctx.app)
      .post(`/conversations/${id}/messages`)
      .set(auth(ctx.traineeToken))
      .send(payload);
    expect(sent.status).toBe(201);
    const retried = await request(ctx.app)
      .post(`/conversations/${id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ ...payload, video_id: '90000000-0000-4000-8000-000000000002' });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(sent.body);
    await request(ctx.app)
      .post(`/conversations/${id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'text', body: 'later', client_id: 'later' });
    const renewed = await request(ctx.app)
      .get(`/conversations/${id}/messages?before_seq=2&limit=1`)
      .set(auth(ctx.coachToken));
    expect(renewed.status).toBe(200);
    expect(renewed.body).toMatchObject({
      messages: [{ seq: 1, video_id: attachment, video_url: expect.any(String) }],
    });
    expect((renewed.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it('keeps shared video access inside the conversation and protects referenced media from deletion', async () => {
    const ctx = await makeUploadsContext();
    const id = await conversation(ctx);
    const attachment = await video(ctx);
    const sent = await request(ctx.app)
      .post(`/conversations/${id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'text', body: '[视频]', video_id: attachment, client_id: 'protected-video' });
    expect(sent.status).toBe(201);
    const generic = await request(ctx.app)
      .get(`/uploads/${attachment}/url`)
      .set(auth(ctx.coachToken));
    expect(generic.status).toBe(404);
    const outsider = await request(ctx.app)
      .get(`/conversations/${id}/messages`)
      .set(auth(ctx.otherCoachToken));
    expect(outsider.status).toBe(404);
    const removed = await request(ctx.app)
      .delete(`/uploads/${attachment}`)
      .set(auth(ctx.traineeToken));
    expect(removed.status).toBe(409);
    expect(removed.body).toEqual({ error: 'ATTACHMENT_IN_USE' });
    expect(ctx.oss.calls.delete).toHaveLength(0);
    const read = await request(ctx.app)
      .get(`/conversations/${id}/messages`)
      .set(auth(ctx.coachToken));
    expect(read.body).toMatchObject({
      messages: [{ video_id: attachment, video_url: expect.any(String) }],
    });
    const wall = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.coachToken));
    expect(wall.status).toBe(200);
    expect(wall.body).toMatchObject({ videos: [] });
  });

  it('uploads without a training set and delivers a legacy-readable message to the coach', async () => {
    const ctx = await makeUploadsContext();
    const id = await conversation(ctx);
    const attachment = await video(ctx);
    const sent = await request(ctx.app)
      .post(`/conversations/${id}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'text', body: '[视频]', video_id: attachment, client_id: 'video-1' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      message: {
        kind: 'text',
        body: '[视频]',
        video_id: attachment,
        set_ref: null,
        exercise_ref: null,
        attachment_id: null,
        video_url: expect.stringContaining('https://fake-oss.invalid/'),
        video_expires_in: 900,
        poster_url: expect.stringContaining('sig=poster'),
      },
    });
    const read = await request(ctx.app)
      .get(`/conversations/${id}/messages`)
      .set(auth(ctx.coachToken));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      messages: [{ kind: 'text', body: '[视频]', video_id: attachment }],
    });
  });
});
