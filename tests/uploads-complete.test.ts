import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids } from './helpers/studentActions';
import { initiateUpload, makeUploadsContext } from './helpers/uploads';

async function initiatedAttachmentId(
  ctx: Awaited<ReturnType<typeof makeUploadsContext>>,
  token: string,
): Promise<string> {
  const res = await initiateUpload(ctx, token, { part_count: 2 });
  expect(res.status).toBe(201);
  return (res.body as { attachment_id: string }).attachment_id;
}

const parts = {
  parts: [
    { part_number: 1, etag: 'etag-1' },
    { part_number: 2, etag: 'etag-2' },
  ],
};

describe('POST /uploads/:attachmentId/complete', () => {
  it('completes the multipart upload and marks the attachment ready', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await initiatedAttachmentId(ctx, ctx.traineeToken);

    const res = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.traineeToken))
      .send(parts);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: attachmentId,
      owner_id: ids.trainee,
      kind: 'set_video',
      oss_key: expect.stringMatching(/^attachments\//),
      content_type: 'video/mp4',
      size_bytes: 50 * 1024 * 1024,
      filename: 'squat-day1.mp4',
      set_log_id: null,
      status: 'ready',
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });

    expect(ctx.oss.calls.complete).toEqual([
      {
        key: res.body.oss_key as string,
        uploadId: 'fake-upload-1',
        parts: parts.parts,
      },
    ]);

    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
    // oss_upload_id is kept post-complete for audit.
    expect(row.oss_upload_id).toBe('fake-upload-1');
  });

  it('returns 404 for non-owner and unknown attachments', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await initiatedAttachmentId(ctx, ctx.traineeToken);

    const otherStudent = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.otherStudentToken))
      .send(parts);
    const boundCoach = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.coachToken))
      .send(parts);
    const unknown = await request(ctx.app)
      .post('/uploads/99999999-0000-4000-8000-000000000099/complete')
      .set(auth(ctx.traineeToken))
      .send(parts);

    expect(otherStudent.status).toBe(404);
    expect(otherStudent.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    // Even the bound coach cannot complete someone else's upload.
    expect(boundCoach.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(ctx.oss.calls.complete).toHaveLength(0);
  });

  it('rejects complete when the attachment is not uploading (state machine)', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await initiatedAttachmentId(ctx, ctx.traineeToken);

    const first = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.traineeToken))
      .send(parts);
    const second = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.traineeToken))
      .send(parts);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('UPLOAD_INVALID_STATE');

    const abortedId = await initiatedAttachmentId(ctx, ctx.traineeToken);
    await request(ctx.app).post(`/uploads/${abortedId}/abort`).set(auth(ctx.traineeToken)).send({});
    const afterAbort = await request(ctx.app)
      .post(`/uploads/${abortedId}/complete`)
      .set(auth(ctx.traineeToken))
      .send(parts);

    expect(afterAbort.status).toBe(409);
    expect(afterAbort.body.error).toBe('UPLOAD_INVALID_STATE');
  });

  it('maps OSS completion failure to 400 UPLOAD_INVALID_PARTS and keeps status uploading', async () => {
    const ctx = await makeUploadsContext({ completeError: new Error('etag mismatch') });
    const attachmentId = await initiatedAttachmentId(ctx, ctx.traineeToken);

    const res = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.traineeToken))
      .send(parts);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'UPLOAD_INVALID_PARTS' });
    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('uploading');
  });

  it('validates the parts body', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await initiatedAttachmentId(ctx, ctx.traineeToken);

    const empty = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({ parts: [] });
    const camel = await request(ctx.app)
      .post(`/uploads/${attachmentId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({ parts: [{ partNumber: 1, etag: 'etag-1' }] });
    const badParam = await request(ctx.app)
      .post('/uploads/not-a-uuid/complete')
      .set(auth(ctx.traineeToken))
      .send(parts);

    for (const res of [empty, camel, badParam]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }
  });

  it('concurrent double-complete: loser gets 409 before OSS is touched', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await initiatedAttachmentId(ctx, ctx.traineeToken);

    const fire = () =>
      request(ctx.app)
        .post(`/uploads/${attachmentId}/complete`)
        .set(auth(ctx.traineeToken))
        .send(parts);
    const [first, second] = await Promise.all([fire(), fire()]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    // The 409 loser reaches its rejection via one of two legitimate, timing-dependent
    // paths, so its body is not byte-stable:
    //   - it also read `uploading`, then lost the atomic conditional UPDATE → the bare
    //     envelope `{ error: 'UPLOAD_INVALID_STATE' }`;
    //   - it read the row *after* the winner advanced it and hit the state-machine guard
    //     → the envelope also reports the observed status, e.g. `completing` / `ready`.
    // Spec 004 guarantees only `409 UPLOAD_INVALID_STATE` for the double-complete loser;
    // `status` is an optional owner-facing detail (cf. uploads-abort's `status:
    // 'completing'` assertion). Assert that stable core, and require any reported status
    // to be an already-advanced state — never `uploading`, which would mean the claim
    // guard let a live upload slip through to OSS.
    expect(loser.body).toMatchObject({ error: 'UPLOAD_INVALID_STATE' });
    if (loser.body.status !== undefined) {
      expect(['completing', 'ready']).toContain(loser.body.status);
    }
    // The atomic claim must keep the loser away from OSS entirely.
    expect(ctx.oss.calls.complete).toHaveLength(1);

    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
  });
});
