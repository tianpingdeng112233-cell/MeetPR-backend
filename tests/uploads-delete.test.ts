import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids } from './helpers/studentActions';
import { createReadyAttachment, initiateUpload, makeUploadsContext } from './helpers/uploads';

describe('DELETE /uploads/:attachmentId', () => {
  it('allows only the owner to delete the OSS object and local metadata', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await createReadyAttachment(ctx, ctx.traineeToken);
    await ctx.db
      .insertInto('onboarding_uploads')
      .values({ user_id: ids.trainee, attachment_id: attachmentId })
      .execute();

    const response = await request(ctx.app)
      .delete(`/uploads/${attachmentId}`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(204);
    expect(
      await ctx.db
        .selectFrom('attachments')
        .select(['id'])
        .where('id', '=', attachmentId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await ctx.db
        .selectFrom('onboarding_uploads')
        .select(['attachment_id'])
        .where('attachment_id', '=', attachmentId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(ctx.oss.calls.abort).toHaveLength(1);
    expect(ctx.oss.calls.delete).toHaveLength(1);

    const gone = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.traineeToken));
    expect(gone.status).toBe(404);
  });

  it('does not expose or delete another owner attachment', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await createReadyAttachment(ctx, ctx.traineeToken);

    const response = await request(ctx.app)
      .delete(`/uploads/${attachmentId}`)
      .set(auth(ctx.otherStudentToken));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    expect(ctx.oss.calls.delete).toHaveLength(0);
  });

  it('restores the original state when OSS deletion fails so the owner can retry', async () => {
    const ctx = await makeUploadsContext({ deleteError: new Error('oss unavailable') });
    const attachmentId = await createReadyAttachment(ctx, ctx.traineeToken);

    const response = await request(ctx.app)
      .delete(`/uploads/${attachmentId}`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'UPLOAD_DELETE_FAILED' });
    const row = await ctx.db
      .selectFrom('attachments')
      .select(['status'])
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
  });

  it('removes a crashed deleting state through reconcile', async () => {
    const ctx = await makeUploadsContext();
    const initiated = await initiateUpload(ctx, ctx.traineeToken);
    const attachmentId = initiated.body.attachment_id as string;
    await ctx.db
      .updateTable('attachments')
      .set({ status: 'deleting' })
      .where('id', '=', attachmentId)
      .execute();

    const response = await request(ctx.app)
      .post(`/uploads/${attachmentId}/reconcile`)
      .set(auth(ctx.traineeToken))
      .send({});

    expect(response.status).toBe(204);
    expect(
      await ctx.db
        .selectFrom('attachments')
        .select(['id'])
        .where('id', '=', attachmentId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });
});
