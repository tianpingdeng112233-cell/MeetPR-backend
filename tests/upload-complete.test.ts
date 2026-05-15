import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  giveVideoConsent,
  makeVideoContext,
  studentId,
  validThumbnailKey,
  validVideoKey,
} from './helpers/video';

function completeBody(videoKey = validVideoKey(), thumbnailKey = validThumbnailKey()) {
  return {
    upload_id: 'upload-test-1',
    oss_key: videoKey,
    parts: [{ part_number: 1, etag: 'part-etag-1' }],
    duration_seconds: 45.2,
    thumbnail_oss_key: thumbnailKey,
    thumbnail_etag: 'thumb-etag',
    recorded_at: '2026-05-15T12:00:00.000Z',
  };
}

describe('POST /upload/complete', () => {
  it('completes OSS multipart upload and inserts visible video attachment', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);
    const videoKey = validVideoKey();
    const thumbnailKey = validThumbnailKey();
    ctx.oss.uploads = [{ key: videoKey, uploadId: 'upload-test-1' }];
    ctx.oss.heads.set(videoKey, { etag: 'video-etag', contentLength: 123_456 });
    ctx.oss.heads.set(thumbnailKey, { etag: 'thumb-etag', contentLength: 1_000 });

    const res = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody(videoKey, thumbnailKey));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      student_id: '10000000-0000-4000-8000-000000000003',
      oss_key: videoKey,
      duration_seconds: '45.20',
      file_size_bytes: 123456,
      thumbnail_oss_key: thumbnailKey,
    });
    expect(res.body.video_url).toContain('method=GET');
    expect(ctx.oss.completed).toHaveLength(1);

    const row = await ctx.db.selectFrom('video_attachments').selectAll().executeTakeFirstOrThrow();
    expect(row.coach_visible_at.toISOString()).toBe(row.uploaded_at.toISOString());
  });

  it('upserts re-recorded video for the same set slot', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);
    const firstVideoKey = validVideoKey();
    const firstThumbnailKey = validThumbnailKey();
    ctx.oss.uploads = [{ key: firstVideoKey, uploadId: 'upload-test-1' }];
    ctx.oss.heads.set(firstVideoKey, { etag: 'video-etag', contentLength: 123_456 });
    ctx.oss.heads.set(firstThumbnailKey, { etag: 'thumb-etag', contentLength: 1_000 });

    await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody(firstVideoKey, firstThumbnailKey));

    const secondVideoKey =
      'students/10000000-0000-4000-8000-000000000003/sets/20000000-0000-4000-8000-000000000001/0/30000000-0000-4000-8000-000000000099.mp4';
    const secondThumbnailKey =
      'students/10000000-0000-4000-8000-000000000003/thumbs/20000000-0000-4000-8000-000000000001/0/30000000-0000-4000-8000-000000000098.jpg';
    ctx.oss.uploads = [{ key: secondVideoKey, uploadId: 'upload-test-2' }];
    ctx.oss.heads.set(secondVideoKey, { etag: 'video-etag-2', contentLength: 456_789 });
    ctx.oss.heads.set(secondThumbnailKey, { etag: 'thumb-etag-2', contentLength: 1_500 });

    const res = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send({
        ...completeBody(secondVideoKey, secondThumbnailKey),
        upload_id: 'upload-test-2',
        thumbnail_etag: 'thumb-etag-2',
      });

    expect(res.status).toBe(201);
    const rows = await ctx.db.selectFrom('video_attachments').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oss_key).toBe(secondVideoKey);
    expect(Number(rows[0]?.file_size_bytes)).toBe(456_789);
  });

  it('rejects missing multipart uploads', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const res = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'UPLOAD_NOT_FOUND' });
  });

  it('rejects invalid parts from OSS complete failures', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);
    const videoKey = validVideoKey();
    const thumbnailKey = validThumbnailKey();
    ctx.oss.uploads = [{ key: videoKey, uploadId: 'upload-test-1' }];
    ctx.oss.completeError = new Error('InvalidPart');

    const res = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody(videoKey, thumbnailKey));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'UPLOAD_INVALID_PARTS' });
  });

  it('rejects cross-student and mismatched thumbnail OSS keys', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const otherStudentVideoKey = validVideoKey('10000000-0000-4000-8000-000000000004');
    const wrongStudent = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody(otherStudentVideoKey, validThumbnailKey()));
    expect(wrongStudent.status).toBe(403);
    expect(wrongStudent.body).toEqual({ error: 'UPLOAD_OSS_KEY_OWNERSHIP' });

    const mismatchedThumbnail = validThumbnailKey(
      studentId,
      '20000000-0000-4000-8000-000000000002',
      0,
    );
    const mismatch = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody(validVideoKey(), mismatchedThumbnail));
    expect(mismatch.status).toBe(403);
    expect(mismatch.body).toEqual({ error: 'UPLOAD_OSS_KEY_OWNERSHIP' });
  });

  it('rejects unpublished plan exercise IDs parsed from the video key', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);
    const unpublishedVideoKey = validVideoKey(studentId, '20000000-0000-4000-8000-000000000099', 0);

    const res = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(
        completeBody(
          unpublishedVideoKey,
          validThumbnailKey(studentId, '20000000-0000-4000-8000-000000000099', 0),
        ),
      );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'UPLOAD_PLAN_EXERCISE_NOT_PUBLISHED' });
  });

  it('rejects invalid thumbnail etags and too-large videos', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);
    const videoKey = validVideoKey();
    const thumbnailKey = validThumbnailKey();
    ctx.oss.uploads = [{ key: videoKey, uploadId: 'upload-test-1' }];
    ctx.oss.heads.set(videoKey, { etag: 'video-etag', contentLength: 1_073_741_825 });
    ctx.oss.heads.set(thumbnailKey, { etag: 'thumb-etag', contentLength: 1_000 });

    const tooLarge = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody(videoKey, thumbnailKey));
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body).toEqual({ error: 'UPLOAD_TOO_LARGE' });

    ctx.oss.heads.set(videoKey, { etag: 'video-etag', contentLength: 123_456 });
    const invalidThumb = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send({ ...completeBody(videoKey, thumbnailKey), thumbnail_etag: 'wrong' });
    expect(invalidThumb.status).toBe(400);
    expect(invalidThumb.body).toEqual({ error: 'UPLOAD_INVALID_THUMBNAIL' });
  });

  it('re-checks consent after OSS completion before inserting the DB row', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);
    const videoKey = validVideoKey();
    const thumbnailKey = validThumbnailKey();
    ctx.oss.uploads = [{ key: videoKey, uploadId: 'upload-test-1' }];
    ctx.oss.heads.set(videoKey, { etag: 'video-etag', contentLength: 123_456 });
    ctx.oss.heads.set(thumbnailKey, { etag: 'thumb-etag', contentLength: 1_000 });

    const originalComplete = ctx.oss.completeMultipartUpload.bind(ctx.oss);
    ctx.oss.completeMultipartUpload = async (key, uploadId, parts) => {
      const result = await originalComplete(key, uploadId, parts);
      await ctx.db
        .deleteFrom('privacy_consents')
        .where('user_id', '=', studentId)
        .where('consent_kind', '=', 'video_visibility_v1')
        .execute();
      return result;
    };

    const res = await request(ctx.app)
      .post('/upload/complete')
      .set(auth(ctx.studentToken))
      .send(completeBody(videoKey, thumbnailKey));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'CONSENT_MISSING' });
    const rows = await ctx.db.selectFrom('video_attachments').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
