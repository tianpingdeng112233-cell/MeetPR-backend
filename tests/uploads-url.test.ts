import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids } from './helpers/studentActions';
import { createReadyAttachment, initiateUpload, makeUploadsContext } from './helpers/uploads';

describe('GET /uploads/:attachmentId/url', () => {
  it('returns a 15min presigned GET URL to the owner', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await createReadyAttachment(ctx, ctx.traineeToken);

    const res = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: expect.stringContaining('https://fake-oss.invalid/attachments/'),
      expires_in: 900,
    });
    // 15min presigned GET TTL invariant.
    expect(ctx.oss.calls.signGet).toEqual([{ key: expect.any(String), expiresSeconds: 900 }]);
  });

  it('allows the accepted-bind coach of the owner', async () => {
    const ctx = await makeUploadsContext();
    // trainee has accepted binds with both coach and otherCoach (fixture).
    const attachmentId = await createReadyAttachment(ctx, ctx.traineeToken);

    const coach = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.coachToken));
    const otherCoach = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.otherCoachToken));

    expect(coach.status).toBe(200);
    expect(otherCoach.status).toBe(200);
  });

  it('returns 404 to coaches without an accepted bind (no existence leak)', async () => {
    const ctx = await makeUploadsContext();
    // otherStudent has no binds at all.
    const attachmentId = await createReadyAttachment(ctx, ctx.otherStudentToken);

    const strangerCoach = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.coachToken));

    expect(strangerCoach.status).toBe(404);
    expect(strangerCoach.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
    expect(ctx.oss.calls.signGet).toHaveLength(0);
  });

  it('returns 404 when the bind is only pending', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await createReadyAttachment(ctx, ctx.otherStudentToken);
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.coach,
        status: 'pending',
        expired_at: new Date('2026-07-01T00:00:00.000Z'),
      })
      .execute();

    const res = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(404);
  });

  it('returns 404 to other students', async () => {
    const ctx = await makeUploadsContext();
    const attachmentId = await createReadyAttachment(ctx, ctx.traineeToken);

    const res = await request(ctx.app)
      .get(`/uploads/${attachmentId}/url`)
      .set(auth(ctx.otherStudentToken));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
  });

  it('returns 409 for attachments that are not ready', async () => {
    const ctx = await makeUploadsContext();
    const initiated = await initiateUpload(ctx, ctx.traineeToken, { part_count: 1 });
    const uploadingId = (initiated.body as { attachment_id: string }).attachment_id;

    const uploading = await request(ctx.app)
      .get(`/uploads/${uploadingId}/url`)
      .set(auth(ctx.traineeToken));
    await request(ctx.app)
      .post(`/uploads/${uploadingId}/abort`)
      .set(auth(ctx.traineeToken))
      .send({});
    const aborted = await request(ctx.app)
      .get(`/uploads/${uploadingId}/url`)
      .set(auth(ctx.traineeToken));

    expect(uploading.status).toBe(409);
    expect(uploading.body.error).toBe('ATTACHMENT_NOT_READY');
    expect(aborted.status).toBe(409);
    expect(aborted.body.error).toBe('ATTACHMENT_NOT_READY');
  });

  it('returns 404 for unknown attachments', async () => {
    const ctx = await makeUploadsContext();

    const res = await request(ctx.app)
      .get('/uploads/99999999-0000-4000-8000-000000000099/url')
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(404);
  });
});
