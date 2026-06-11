import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { auth } from './helpers/studentActions';
import { createReadyAttachment, initiateUpload, makeUploadsContext } from './helpers/uploads';

describe('POST /uploads/:attachmentId/abort', () => {
  it('aborts an uploading attachment and is idempotent on re-abort', async () => {
    const ctx = await makeUploadsContext();
    const initiated = await initiateUpload(ctx, ctx.traineeToken, { part_count: 1 });
    const attachmentId = (initiated.body as { attachment_id: string }).attachment_id;

    const first = await request(ctx.app)
      .post(`/uploads/${attachmentId}/abort`)
      .set(auth(ctx.traineeToken))
      .send({});
    const second = await request(ctx.app)
      .post(`/uploads/${attachmentId}/abort`)
      .set(auth(ctx.traineeToken))
      .send({});

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('aborted');
    // OSS abort called exactly once; the idempotent retry short-circuits in DB.
    expect(ctx.oss.calls.abort).toEqual([{ key: row.oss_key, uploadId: 'fake-upload-1' }]);
  });

  it('rejects abort on a ready attachment', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await createReadyAttachment(ctx, ctx.traineeToken);

    const res = await request(ctx.app)
      .post(`/uploads/${attachmentId}/abort`)
      .set(auth(ctx.traineeToken))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('UPLOAD_INVALID_STATE');
  });

  it('returns 404 for non-owner and unknown attachments', async () => {
    const ctx = await makeUploadsContext();
    const initiated = await initiateUpload(ctx, ctx.traineeToken, { part_count: 1 });
    const attachmentId = (initiated.body as { attachment_id: string }).attachment_id;

    const otherStudent = await request(ctx.app)
      .post(`/uploads/${attachmentId}/abort`)
      .set(auth(ctx.otherStudentToken))
      .send({});
    const unknown = await request(ctx.app)
      .post('/uploads/99999999-0000-4000-8000-000000000099/abort')
      .set(auth(ctx.traineeToken))
      .send({});

    expect(otherStudent.status).toBe(404);
    expect(otherStudent.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    expect(unknown.status).toBe(404);
    expect(ctx.oss.calls.abort).toHaveLength(0);
  });

  it('rejects a non-empty abort body (strict wire shape)', async () => {
    const ctx = await makeUploadsContext();
    const initiated = await initiateUpload(ctx, ctx.traineeToken, { part_count: 1 });
    const attachmentId = (initiated.body as { attachment_id: string }).attachment_id;

    const res = await request(ctx.app)
      .post(`/uploads/${attachmentId}/abort`)
      .set(auth(ctx.traineeToken))
      .send({ foo: 'bar' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('uploading');
  });

  it('stale abort loses to a concurrent complete-claim and never touches OSS', async () => {
    // Deterministic interleave (Codex second-pass P1): freeze complete inside
    // its OSS call (claim already done), fire abort, then fail the OSS
    // complete so it rolls back. The upload must stay resumable and OSS must
    // never see an abort.
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const ctx = await makeUploadsContext({
      completeGate: () => gate,
      completeError: new Error('oss complete failed'),
    });
    const initiated = await initiateUpload(ctx, ctx.traineeToken, { part_count: 1 });
    const attachmentId = (initiated.body as { attachment_id: string }).attachment_id;

    const completePromise = request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({ parts: [{ part_number: 1, etag: 'etag-1' }] })
      .then((res) => res);
    // Wait until complete has claimed the row and is parked inside OSS.
    await vi.waitFor(() => {
      expect(ctx.oss.calls.complete).toHaveLength(1);
    });

    const abort = await request(ctx.app)
      .post(`/uploads/${attachmentId}/abort`)
      .set(auth(ctx.traineeToken))
      .send({});
    expect(abort.status).toBe(409);
    expect(abort.body).toEqual({ error: 'UPLOAD_INVALID_STATE', status: 'completing' });
    expect(ctx.oss.calls.abort).toHaveLength(0);

    releaseGate?.();
    const complete = await completePromise;
    expect(complete.status).toBe(400);
    expect(complete.body).toEqual({ error: 'UPLOAD_INVALID_PARTS' });

    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('uploading');
    expect(ctx.oss.calls.abort).toHaveLength(0);
  });
});
