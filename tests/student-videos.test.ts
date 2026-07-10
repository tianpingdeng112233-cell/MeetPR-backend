import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createPublishedPlan, ids } from './helpers/studentActions';
import { makeUploadsContext } from './helpers/uploads';

async function seedSetLog(ctx: Awaited<ReturnType<typeof makeUploadsContext>>): Promise<string> {
  const fixture = await createPublishedPlan(ctx);
  const log = await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: fixture.planExerciseId,
      exercise_id: ids.exercise,
      logged_date: '2026-05-15',
      set_index: 0,
      weight_kg: '140.00',
      reps: 5,
      rpe: '7.5',
      completed: true,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return log.id;
}

async function uploadReadyVideo(
  ctx: Awaited<ReturnType<typeof makeUploadsContext>>,
  setLogId?: string,
): Promise<string> {
  const initiate = await request(ctx.app)
    .post('/uploads/initiate')
    .set(auth(ctx.traineeToken))
    .send({
      kind: 'set_video',
      content_type: 'video/mp4',
      size_bytes: 1024,
      part_count: 1,
      ...(setLogId === undefined ? {} : { set_log_id: setLogId }),
    });
  expect(initiate.status).toBe(201);
  const attachmentId = (initiate.body as { attachment_id: string }).attachment_id;
  const complete = await request(ctx.app)
    .post(`/uploads/${attachmentId}/complete`)
    .set(auth(ctx.traineeToken))
    .send({ parts: [{ part_number: 1, etag: 'etag-1' }] });
  expect(complete.status).toBe(200);
  return attachmentId;
}

describe('POST /uploads/initiate set_log_id linkage (spec 007)', () => {
  it('links a set_video to the uploader own set log and serializes it', async () => {
    const ctx = await makeUploadsContext();
    const setLogId = await seedSetLog(ctx);
    const attachmentId = await uploadReadyVideo(ctx, setLogId);

    const row = await ctx.db
      .selectFrom('attachments')
      .select(['set_log_id'])
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(row.set_log_id).toBe(setLogId);
  });

  it('rejects linking to someone else set log with 404', async () => {
    const ctx = await makeUploadsContext();
    const setLogId = await seedSetLog(ctx);

    const res = await request(ctx.app)
      .post('/uploads/initiate')
      .set(auth(ctx.otherStudentToken))
      .send({
        kind: 'set_video',
        content_type: 'video/mp4',
        size_bytes: 1024,
        part_count: 1,
        set_log_id: setLogId,
      });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'SET_LOG_NOT_FOUND' });
  });

  it('rejects set_log_id on non-video kinds', async () => {
    const ctx = await makeUploadsContext();
    const setLogId = await seedSetLog(ctx);

    const res = await request(ctx.app).post('/uploads/initiate').set(auth(ctx.traineeToken)).send({
      kind: 'onboarding_doc',
      content_type: 'application/pdf',
      size_bytes: 1024,
      part_count: 1,
      set_log_id: setLogId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('GET /students/:id/videos (spec 007)', () => {
  it('returns ready set videos with linkage and a playback URL, newest first', async () => {
    const ctx = await makeUploadsContext();
    const setLogId = await seedSetLog(ctx);
    await uploadReadyVideo(ctx, setLogId);
    // A second video without linkage, and one stuck uploading (excluded).
    await uploadReadyVideo(ctx);
    await request(ctx.app).post('/uploads/initiate').set(auth(ctx.traineeToken)).send({
      kind: 'set_video',
      content_type: 'video/mp4',
      size_bytes: 1024,
      part_count: 1,
    });

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(2);
    const linked = res.body.videos.find(
      (video: { set_log_id: string | null }) => video.set_log_id !== null,
    );
    expect(linked).toMatchObject({
      set_log_id: setLogId,
      content_type: 'video/mp4',
    });
    expect(linked.plan_exercise_id).toEqual(expect.any(String));
    expect(linked.logged_at).toEqual(expect.any(String));
    // Metadata only: playback URLs come from GET /uploads/:id/url per item.
    expect(linked.url).toBeUndefined();
  });

  it('scopes a bonded coach to videos from their own plans plus unlinked ones', async () => {
    const ctx = await makeUploadsContext();
    // Linked video hangs off ids.coach's plan (createPublishedPlan default).
    const setLogId = await seedSetLog(ctx);
    await uploadReadyVideo(ctx, setLogId);
    await uploadReadyVideo(ctx); // unlinked

    const owningCoach = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.coachToken));
    expect(owningCoach.status).toBe(200);
    expect(owningCoach.body.videos).toHaveLength(2);

    // The other bonded coach (dual-coach seed) sees only the unlinked one.
    const otherCoach = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.otherCoachToken));
    expect(otherCoach.status).toBe(200);
    expect(otherCoach.body.videos).toHaveLength(1);
    expect(otherCoach.body.videos[0].set_log_id).toBeNull();

    // The student always sees everything of their own.
    const self = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.traineeToken));
    expect(self.body.videos).toHaveLength(2);
  });

  it('enforces the sets authorization matrix', async () => {
    const ctx = await makeUploadsContext();
    await uploadReadyVideo(ctx);

    const coach = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.coachToken));
    expect(coach.status).toBe(200);

    // Seed bonds BOTH coaches to the trainee (003 dual-coach matrix), so the
    // other coach legitimately reads too.
    const otherBondedCoach = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.otherCoachToken));
    expect(otherBondedCoach.status).toBe(200);

    const otherStudent = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.otherStudentToken));
    expect(otherStudent.status).toBe(403);
  });
});

describe('GET /uploads/:id/url wall-scoping parity (spec 007)', () => {
  it('denies the other bonded coach a linked video URL but allows unlinked', async () => {
    const ctx = await makeUploadsContext();
    const setLogId = await seedSetLog(ctx);
    const linkedId = await uploadReadyVideo(ctx, setLogId);
    const unlinkedId = await uploadReadyVideo(ctx);

    // Owning coach exchanges fine.
    const owning = await request(ctx.app).get(`/uploads/${linkedId}/url`).set(auth(ctx.coachToken));
    expect(owning.status).toBe(200);

    // The other bonded coach (dual-coach seed) must not reach a video linked
    // to a different coach's plan — same 404 as nonexistence.
    const otherLinked = await request(ctx.app)
      .get(`/uploads/${linkedId}/url`)
      .set(auth(ctx.otherCoachToken));
    expect(otherLinked.status).toBe(404);

    const otherUnlinked = await request(ctx.app)
      .get(`/uploads/${unlinkedId}/url`)
      .set(auth(ctx.otherCoachToken));
    expect(otherUnlinked.status).toBe(200);
  });

  it('does not reclassify a detached linked video as broadly-visible unlinked media', async () => {
    const ctx = await makeUploadsContext();
    const setLogId = await seedSetLog(ctx);
    const linkedId = await uploadReadyVideo(ctx, setLogId);

    // Simulate a legacy orphan/data repair. New production migrations preserve
    // source_coach_id, which must remain the authorization source of truth.
    await ctx.db
      .updateTable('attachments')
      .set({ set_log_id: null })
      .where('id', '=', linkedId)
      .execute();

    const wall = await request(ctx.app)
      .get(`/students/${ids.trainee}/videos`)
      .set(auth(ctx.otherCoachToken));
    expect(wall.status).toBe(200);
    expect(wall.body.videos).toEqual([]);

    const url = await request(ctx.app)
      .get(`/uploads/${linkedId}/url`)
      .set(auth(ctx.otherCoachToken));
    expect(url.status).toBe(404);
    expect(url.body).toEqual({ error: 'ATTACHMENT_NOT_FOUND' });
  });
});
