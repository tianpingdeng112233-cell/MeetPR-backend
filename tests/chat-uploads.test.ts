import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { TestContext } from './helpers/studentActions';
import { auth, ids, makeContext } from './helpers/studentActions';
import {
  createReadyAttachment,
  initiateUpload,
  makeUploadsContext,
  type UploadsContext,
} from './helpers/uploads';

async function chooseCanonicalCoach(ctx: TestContext): Promise<void> {
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .where('coach_id', '=', ids.coach)
    .execute();
}

async function createConversation(ctx: TestContext): Promise<string> {
  await chooseCanonicalCoach(ctx);
  const response = await request(ctx.app)
    .post('/conversations')
    .set(auth(ctx.coachToken))
    .send({ other_user_id: ids.trainee });
  expect(response.status).toBe(201);
  return (response.body as { conversation: { id: string } }).conversation.id;
}

async function createReadyChatImage(ctx: UploadsContext, token: string): Promise<string> {
  return createReadyAttachment(ctx, token, {
    kind: 'chat_image',
    content_type: 'image/jpeg',
    size_bytes: 2 * 1024 * 1024,
    filename: 'chat.jpg',
  });
}

describe('chat_image messages and URL authorization', () => {
  it('lets both members read through messages but keeps the generic URL owner-only', async () => {
    const ctx = await makeUploadsContext();
    const conversationId = await createConversation(ctx);
    const attachmentId = await createReadyChatImage(ctx, ctx.traineeToken);

    const sent = await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'image', attachment_id: attachmentId, client_id: 'image-1' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      message: {
        kind: 'image',
        body: null,
        attachment_id: attachmentId,
        image_url: expect.stringContaining('https://fake-oss.invalid/'),
        image_expires_in: 900,
      },
    });

    const coachMessages = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken));
    expect(coachMessages.status).toBe(200);
    expect(coachMessages.body).toMatchObject({
      messages: [
        {
          attachment_id: attachmentId,
          image_url: expect.stringContaining('https://fake-oss.invalid/'),
          image_expires_in: 900,
        },
      ],
    });

    const ownerUrl = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.traineeToken));
    const signCountBeforeNonOwner = ctx.oss.calls.signGet.length;
    const coachGenericUrl = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.coachToken));
    const otherCoachGenericUrl = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.otherCoachToken));

    expect(ownerUrl.status).toBe(200);
    expect(coachGenericUrl.status).toBe(404);
    expect(otherCoachGenericUrl.status).toBe(404);
    expect(coachGenericUrl.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    expect(ctx.oss.calls.signGet).toHaveLength(signCountBeforeNonOwner);
  });

  it('rejects wrong owner, wrong kind, non-ready, and missing attachments', async () => {
    const ctx = await makeUploadsContext();
    const conversationId = await createConversation(ctx);
    const studentImage = await createReadyChatImage(ctx, ctx.traineeToken);
    const coachVideo = await createReadyAttachment(ctx, ctx.coachToken);
    const uploading = await initiateUpload(ctx, ctx.coachToken, {
      kind: 'chat_image',
      content_type: 'image/png',
      size_bytes: 2 * 1024 * 1024,
      filename: 'uploading.png',
      part_count: 1,
    });
    const uploadingId = (uploading.body as { attachment_id: string }).attachment_id;

    for (const [attachmentId, clientId] of [
      [studentImage, 'bad-owner'],
      [coachVideo, 'bad-kind'],
      [uploadingId, 'bad-status'],
      ['90000000-0000-4000-8000-000000000099', 'bad-missing'],
    ]) {
      const response = await request(ctx.app)
        .post(`/conversations/${conversationId}/messages`)
        .set(auth(ctx.coachToken))
        .send({ kind: 'image', attachment_id: attachmentId, client_id: clientId });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'CHAT_INVALID_ATTACHMENT' });
    }
  });

  it('writes image messages without OSS config and returns a null URL placeholder', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);
    const attachment = await ctx.db
      .insertInto('attachments')
      .values({
        owner_id: ids.coach,
        kind: 'chat_image',
        oss_key: 'attachments/coach/no-oss.jpg',
        oss_upload_id: 'no-oss-upload',
        content_type: 'image/jpeg',
        size_bytes: 1024,
        filename: 'no-oss.jpg',
        set_log_id: null,
        source_plan_id: null,
        source_coach_id: null,
        is_unlinked_explicit: true,
        part_count: 1,
        actual_size_bytes: 1024,
        status: 'ready',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const sent = await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'image', attachment_id: attachment.id, client_id: 'no-oss-1' });
    const listed = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.traineeToken));

    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      message: { image_url: null, image_expires_in: 900 },
    });
    expect(listed.body).toMatchObject({
      messages: [{ image_url: null, image_expires_in: 900 }],
    });
  });

  it('signs conversation attachment URLs for the current Global requester', async () => {
    const ctx = await makeUploadsContext({
      accelerateEndpoint: 'https://oss-accelerate.aliyuncs.com',
    });
    const conversationId = await createConversation(ctx);
    const attachmentId = await createReadyChatImage(ctx, ctx.traineeToken);
    await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'image', attachment_id: attachmentId, client_id: 'accelerated-image' });
    await ctx.db.updateTable('users').set({ phone: null }).where('id', '=', ids.coach).execute();

    const response = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(new URL(response.body.messages[0].image_url as string).hostname).toBe(
      'oss-accelerate.aliyuncs.com',
    );
    expect(response.body.messages[0].image_expires_in).toBe(900);
  });
});

describe('referenced chat_image deletion', () => {
  it('returns ATTACHMENT_IN_USE without touching OSS or metadata', async () => {
    const ctx = await makeUploadsContext();
    const conversationId = await createConversation(ctx);
    const attachmentId = await createReadyChatImage(ctx, ctx.traineeToken);
    await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'image', attachment_id: attachmentId, client_id: 'delete-guard-1' });

    const response = await request(ctx.app)
      .delete(`/uploads/${attachmentId}`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'ATTACHMENT_IN_USE' });
    expect(ctx.oss.calls.abort).toHaveLength(0);
    expect(ctx.oss.calls.delete).toHaveLength(0);
    expect(
      await ctx.db
        .selectFrom('attachments')
        .select('status')
        .where('id', '=', attachmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'ready' });
    expect(
      await ctx.db
        .selectFrom('messages')
        .select('id')
        .where('attachment_id', '=', attachmentId)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it('applies the same reference lock/check to reconcile-delete', async () => {
    const ctx = await makeUploadsContext();
    const conversationId = await createConversation(ctx);
    const attachmentId = await createReadyChatImage(ctx, ctx.traineeToken);
    await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'image', attachment_id: attachmentId, client_id: 'reconcile-guard-1' });
    await ctx.db
      .updateTable('attachments')
      .set({ status: 'deleting' })
      .where('id', '=', attachmentId)
      .execute();

    const response = await request(ctx.app)
      .post(`/uploads/${attachmentId}/reconcile`)
      .set(auth(ctx.traineeToken))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'ATTACHMENT_IN_USE' });
    expect(ctx.oss.calls.abort).toHaveLength(0);
    expect(ctx.oss.calls.delete).toHaveLength(0);
  });

  it('has only the safe send-wins or delete-wins outcome under a concurrent race', async () => {
    const ctx = await makeUploadsContext();
    const conversationId = await createConversation(ctx);
    const attachmentId = await createReadyChatImage(ctx, ctx.traineeToken);

    const [send, deletion] = await Promise.all([
      request(ctx.app)
        .post(`/conversations/${conversationId}/messages`)
        .set(auth(ctx.traineeToken))
        .send({ kind: 'image', attachment_id: attachmentId, client_id: 'delete-race-1' }),
      request(ctx.app).delete(`/uploads/${attachmentId}`).set(auth(ctx.traineeToken)),
    ]);
    const storedMessage = await ctx.db
      .selectFrom('messages')
      .select('id')
      .where('attachment_id', '=', attachmentId)
      .executeTakeFirst();
    const storedAttachment = await ctx.db
      .selectFrom('attachments')
      .select('id')
      .where('id', '=', attachmentId)
      .executeTakeFirst();

    if (send.status === 201) {
      expect(deletion.status).toBe(409);
      expect(deletion.body).toEqual({ error: 'ATTACHMENT_IN_USE' });
      expect(storedMessage).toBeDefined();
      expect(storedAttachment).toBeDefined();
      expect(ctx.oss.calls.delete).toHaveLength(0);
    } else {
      expect(send.status).toBe(400);
      expect(send.body).toEqual({ error: 'CHAT_INVALID_ATTACHMENT' });
      expect(deletion.status).toBe(204);
      expect(storedMessage).toBeUndefined();
      expect(storedAttachment).toBeUndefined();
      expect(ctx.oss.calls.delete).toHaveLength(1);
    }
  });
});

describe('uploads.chat_image limits', () => {
  it('accepts jpeg/png through 10MB and rejects oversized or non-image content', async () => {
    const ctx = await makeUploadsContext();
    const jpeg = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'chat_image',
      content_type: 'image/jpeg',
      size_bytes: 10 * 1024 * 1024,
      part_count: 1,
    });
    const png = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'chat_image',
      content_type: 'image/png',
      size_bytes: 1024 * 1024,
      part_count: 1,
    });
    const oversized = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'chat_image',
      content_type: 'image/jpeg',
      size_bytes: 10 * 1024 * 1024 + 1,
      part_count: 1,
    });
    const wrongType = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'chat_image',
      content_type: 'image/gif',
      size_bytes: 1024 * 1024,
      part_count: 1,
    });

    expect(jpeg.status).toBe(201);
    expect(png.status).toBe(201);
    expect(oversized.status).toBe(400);
    expect(oversized.body).toMatchObject({
      error: 'UPLOAD_TOO_LARGE',
      max_size_bytes: 10 * 1024 * 1024,
    });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body).toMatchObject({
      error: 'UPLOAD_CONTENT_TYPE_MISMATCH',
      allowed_content_types: ['image/jpeg', 'image/png'],
    });
  });
});
