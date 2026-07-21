import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AttachmentKind, AttachmentStatus } from '../src/db/types';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from './helpers/studentActions';

async function seedAttachment(
  ctx: TestContext,
  overrides: {
    owner_id?: string;
    kind?: AttachmentKind;
    status?: AttachmentStatus;
    source_coach_id?: string | null;
    is_unlinked_explicit?: boolean;
  } = {},
): Promise<string> {
  const attachment = await ctx.db
    .insertInto('attachments')
    .values({
      owner_id: ids.trainee,
      kind: 'set_video',
      oss_key: `feedback-test/${crypto.randomUUID()}`,
      content_type: 'video/mp4',
      size_bytes: 1024,
      filename: 'set.mp4',
      part_count: 1,
      status: 'ready',
      // Mirrors what POST /uploads/initiate writes for a set-linked video: the
      // owning coach is captured at upload time. A row with neither a source
      // coach nor an explicit unlinked flag is an orphan, which the video wall
      // deliberately hides — don't let fixtures invent that shape.
      source_coach_id: ids.coach,
      ...overrides,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return attachment.id;
}

describe('POST /coach/feedback', () => {
  it('creates trimmed feedback for an owned published plan exercise', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const videoId = await seedAttachment(ctx);

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      day_date: '2026-05-15',
      plan_exercise_id: plan.planExerciseId,
      video_id: videoId,
      text: '  Strong top set  ',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      coach_id: ids.coach,
      student_id: ids.trainee,
      day_date: '2026-05-15',
      plan_exercise_id: plan.planExerciseId,
      video_id: videoId,
      text: 'Strong top set',
      read_at: null,
    });

    const stored = await ctx.db
      .selectFrom('feedback')
      .select(['video_id'])
      .where('id', '=', res.body.id as string)
      .executeTakeFirstOrThrow();
    expect(stored.video_id).toBe(videoId);
  });

  it('allows video_id without plan_exercise_id through coarse coach ownership', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    const videoId = await seedAttachment(ctx);

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      video_id: videoId,
      text: 'Good session',
    });

    expect(res.status).toBe(201);
    expect(res.body.day_date).toBeNull();
    expect(res.body.plan_exercise_id).toBeNull();
    expect(res.body.video_id).toBe(videoId);
  });

  it('rejects a video owned by another student', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    const videoId = await seedAttachment(ctx, { owner_id: ids.otherStudent });

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      video_id: videoId,
      text: 'Wrong student video',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'FEEDBACK_VIDEO_NOT_OWNED' });
  });

  it('rejects a video uploaded under another coach for the same student', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    // Dual-coach student: this clip belongs to the other coach's plan, so the
    // video wall hides it from this coach. Linking it through feedback would
    // hand it back — same gate, same answer.
    const videoId = await seedAttachment(ctx, { source_coach_id: ids.otherCoach });

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      video_id: videoId,
      text: 'Another coach video',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'FEEDBACK_VIDEO_NOT_OWNED' });
  });

  it('accepts a freely recorded video that belongs to no coach', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    const videoId = await seedAttachment(ctx, {
      source_coach_id: null,
      is_unlinked_explicit: true,
    });

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      video_id: videoId,
      text: 'Freely recorded clip',
    });

    expect(res.status).toBe(201);
    expect(res.body.video_id).toBe(videoId);
  });

  it('rejects an orphaned video with neither a source coach nor the unlinked flag', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    const videoId = await seedAttachment(ctx, { source_coach_id: null });

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      video_id: videoId,
      text: 'Orphan clip',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'FEEDBACK_VIDEO_NOT_OWNED' });
  });

  it('rejects a coach with no accepted bond to the student', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.otherStudent,
      text: 'No relationship',
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it.each([
    ['a non-ready video', { status: 'uploading' as const }],
    ['a non-set-video attachment', { kind: 'onboarding_video' as const }],
  ])('rejects %s', async (_label, overrides) => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    const videoId = await seedAttachment(ctx, overrides);

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      video_id: videoId,
      text: 'Invalid attachment',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'FEEDBACK_VIDEO_NOT_OWNED' });
  });

  it('keeps the legacy request behavior and adds only video_id to its response shape', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      text: 'Legacy request',
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'id',
        'coach_id',
        'student_id',
        'day_date',
        'plan_exercise_id',
        'video_id',
        'text',
        'posted_at',
        'read_at',
      ].sort(),
    );
    expect(res.body).toMatchObject({
      coach_id: ids.coach,
      student_id: ids.trainee,
      day_date: null,
      plan_exercise_id: null,
      video_id: null,
      text: 'Legacy request',
      read_at: null,
    });
  });

  it('rejects non-coach and plan exercises owned by another coach', async () => {
    const ctx = await makeContext();
    const otherPlan = await createPublishedPlan(ctx, ids.otherCoach, ids.trainee);

    const asStudent = await request(ctx.app)
      .post('/coach/feedback')
      .set(auth(ctx.traineeToken))
      .send({ student_id: ids.trainee, text: 'Nope' });
    const wrongCoachExercise = await request(ctx.app)
      .post('/coach/feedback')
      .set(auth(ctx.coachToken))
      .send({
        student_id: ids.trainee,
        plan_exercise_id: otherPlan.planExerciseId,
        text: 'No cross-coach writes',
      });

    expect(asStudent.status).toBe(403);
    expect(wrongCoachExercise.status).toBe(400);
    expect(wrongCoachExercise.body).toEqual({ error: 'FEEDBACK_PLAN_EXERCISE_NOT_OWNED' });
  });
});
