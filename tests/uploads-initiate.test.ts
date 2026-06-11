import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids } from './helpers/studentActions';
import { initiateUpload, makeUploadsContext } from './helpers/uploads';

const MB = 1024 * 1024;

describe('POST /uploads/initiate', () => {
  it('initiates a set_video upload and returns one presigned URL per part', async () => {
    const ctx = await makeUploadsContext();

    const res = await initiateUpload(ctx, ctx.traineeToken, { part_count: 3 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      attachment_id: expect.any(String),
      upload_id: 'fake-upload-1',
      part_urls: [
        { part_number: 1, url: expect.any(String) },
        { part_number: 2, url: expect.any(String) },
        { part_number: 3, url: expect.any(String) },
      ],
    });

    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', res.body.attachment_id as string)
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(ids.trainee);
    expect(row.kind).toBe('set_video');
    expect(row.status).toBe('uploading');
    expect(row.oss_upload_id).toBe('fake-upload-1');
    expect(row.filename).toBe('squat-day1.mp4');
    expect(row.oss_key).toMatch(
      new RegExp(
        `^attachments/${ids.trainee}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.mp4$`,
      ),
    );

    // 1h presigned PUT TTL invariant.
    expect(ctx.oss.calls.signParts).toEqual([
      { key: row.oss_key, uploadId: 'fake-upload-1', partCount: 3, expiresSeconds: 3600 },
    ]);
    expect(ctx.oss.calls.initiate).toEqual([{ key: row.oss_key, contentType: 'video/mp4' }]);
  });

  it('initiates onboarding kinds and derives the extension from content_type', async () => {
    const ctx = await makeUploadsContext();

    const pdf = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'onboarding_doc',
      content_type: 'application/pdf',
      size_bytes: 5 * MB,
      part_count: 1,
      filename: 'old-plan.pdf',
    });
    const mov = await initiateUpload(ctx, ctx.selfTrainStudentToken, {
      kind: 'onboarding_video',
      content_type: 'video/quicktime',
      size_bytes: 80 * MB,
      part_count: 2,
    });

    expect(pdf.status).toBe(201);
    expect(mov.status).toBe(201);
    const rows = await ctx.db.selectFrom('attachments').selectAll().execute();
    const keys = rows.map((row) => row.oss_key);
    expect(keys.some((key) => key.endsWith('.pdf'))).toBe(true);
    expect(keys.some((key) => key.endsWith('.mov'))).toBe(true);
  });

  it('allows any authenticated role to upload its own attachments', async () => {
    const ctx = await makeUploadsContext();

    const res = await initiateUpload(ctx, ctx.coachToken, { part_count: 1 });

    expect(res.status).toBe(201);
    const row = await ctx.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', res.body.attachment_id as string)
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(ids.coach);
  });

  it('rejects content types outside the kind whitelist', async () => {
    const ctx = await makeUploadsContext();

    const imageAsVideo = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'set_video',
      content_type: 'image/png',
    });
    const videoAsDoc = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'onboarding_doc',
      content_type: 'video/mp4',
      size_bytes: 5 * MB,
    });
    const unknown = await initiateUpload(ctx, ctx.traineeToken, {
      content_type: 'application/octet-stream',
    });

    expect(imageAsVideo.status).toBe(400);
    expect(imageAsVideo.body.error).toBe('UPLOAD_CONTENT_TYPE_MISMATCH');
    expect(videoAsDoc.status).toBe(400);
    expect(videoAsDoc.body.error).toBe('UPLOAD_CONTENT_TYPE_MISMATCH');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('UPLOAD_CONTENT_TYPE_MISMATCH');
    expect(ctx.oss.calls.initiate).toHaveLength(0);
  });

  it('enforces per-kind size caps at the exact boundary', async () => {
    const ctx = await makeUploadsContext();

    const videoAtCap = await initiateUpload(ctx, ctx.traineeToken, {
      size_bytes: 200 * MB,
    });
    const videoOverCap = await initiateUpload(ctx, ctx.traineeToken, {
      size_bytes: 200 * MB + 1,
    });
    const docAtCap = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'onboarding_doc',
      content_type: 'image/jpeg',
      size_bytes: 20 * MB,
    });
    const docOverCap = await initiateUpload(ctx, ctx.traineeToken, {
      kind: 'onboarding_doc',
      content_type: 'image/jpeg',
      size_bytes: 20 * MB + 1,
    });

    expect(videoAtCap.status).toBe(201);
    expect(videoOverCap.status).toBe(400);
    expect(videoOverCap.body.error).toBe('UPLOAD_TOO_LARGE');
    expect(docAtCap.status).toBe(201);
    expect(docOverCap.status).toBe(400);
    expect(docOverCap.body.error).toBe('UPLOAD_TOO_LARGE');
  });

  it('validates part_count bounds and body shape', async () => {
    const ctx = await makeUploadsContext();

    const zeroParts = await initiateUpload(ctx, ctx.traineeToken, { part_count: 0 });
    const tooManyParts = await initiateUpload(ctx, ctx.traineeToken, { part_count: 10_001 });
    const badKind = await initiateUpload(ctx, ctx.traineeToken, { kind: 'avatar' });
    const negativeSize = await initiateUpload(ctx, ctx.traineeToken, { size_bytes: -1 });

    for (const res of [zeroParts, tooManyParts, badKind, negativeSize]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }
    expect(ctx.oss.calls.initiate).toHaveLength(0);
  });

  it('rejects camelCase request fields (snake_case wire shape)', async () => {
    const ctx = await makeUploadsContext();

    const res = await request(ctx.app).post('/uploads/initiate').set(auth(ctx.traineeToken)).send({
      kind: 'set_video',
      contentType: 'video/mp4',
      sizeBytes: 1024,
      partCount: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    const ctx = await makeUploadsContext();

    const res = await request(ctx.app).post('/uploads/initiate').send({});

    expect(res.status).toBe(401);
  });
});
