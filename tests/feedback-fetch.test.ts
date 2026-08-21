import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from './helpers/studentActions';

async function seedLinkedVideo(ctx: TestContext, rpe: string | null = '8.5'): Promise<string> {
  const plan = await createPublishedPlan(ctx);
  const setLog = await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: plan.planExerciseId,
      exercise_id: ids.exercise,
      set_index: 2,
      weight_kg: '125.00',
      reps: 4,
      rpe,
      completed: true,
      logged_date: '2026-07-17',
      logged_at: new Date('2026-07-17T10:20:30.000Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const attachment = await ctx.db
    .insertInto('attachments')
    .values({
      owner_id: ids.trainee,
      kind: 'set_video',
      oss_key: `feedback-fetch/${crypto.randomUUID()}`,
      content_type: 'video/mp4',
      size_bytes: 1024,
      filename: 'squat.mp4',
      set_log_id: setLog.id,
      source_plan_id: plan.planId,
      source_coach_id: ids.coach,
      part_count: 1,
      status: 'ready',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return attachment.id;
}

describe('GET /students/:id/feedback', () => {
  it('returns all own feedback ordered by posted_at descending', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('feedback')
      .values([
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: '2026-05-14',
          plan_exercise_id: plan.planExerciseId,
          text: 'Earlier',
          posted_at: new Date('2026-05-14T12:00:00.000Z'),
        },
        {
          coach_id: ids.otherCoach,
          student_id: ids.trainee,
          day_date: '2026-05-15',
          plan_exercise_id: null,
          text: 'Later',
          posted_at: new Date('2026-05-15T12:00:00.000Z'),
        },
      ])
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { text: string }) => item.text)).toEqual(['Later', 'Earlier']);
    expect(
      res.body.items.every((item: { video_id: string | null }) => item.video_id === null),
    ).toBe(true);
    expect(res.body.items.every((item: { video: object | null }) => item.video === null)).toBe(
      true,
    );
  });

  it('returns linked video metadata and null for unlinked feedback without playback URLs', async () => {
    const ctx = await makeContext();
    const videoId = await seedLinkedVideo(ctx);
    await ctx.db
      .insertInto('feedback')
      .values([
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: '2026-07-17',
          plan_exercise_id: null,
          video_id: videoId,
          text: 'Linked feedback',
          posted_at: new Date('2026-07-17T12:00:00.000Z'),
        },
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: '2026-07-16',
          plan_exercise_id: null,
          video_id: null,
          text: 'Unlinked feedback',
          posted_at: new Date('2026-07-16T12:00:00.000Z'),
        },
      ])
      .execute();

    await ctx.db
      .updateTable('exercises')
      .set({ name_en: 'Competition Squat (EN)' })
      .where('name', '=', 'Competition Squat')
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      text: 'Linked feedback',
      video_id: videoId,
      video: {
        id: videoId,
        exercise_name: 'Competition Squat',
        exercise_name_en: 'Competition Squat (EN)',
        set_index: 2,
        weight_kg: '125.00',
        reps: 4,
        rpe: '8.5',
        logged_at: '2026-07-17T10:20:30.000Z',
      },
    });
    expect(res.body.items[0].video.url).toBeUndefined();
    expect(res.body.items[1]).toMatchObject({
      text: 'Unlinked feedback',
      video_id: null,
      video: null,
    });
  });

  it('projects an integer RPE as a one-decimal string and an unrated set as null', async () => {
    const ctx = await makeContext();
    const ratedVideoId = await seedLinkedVideo(ctx, '8');
    const unratedVideoId = await seedLinkedVideo(ctx, null);
    await ctx.db
      .insertInto('feedback')
      .values([
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: '2026-07-17',
          plan_exercise_id: null,
          video_id: ratedVideoId,
          text: 'Rated',
          posted_at: new Date('2026-07-17T12:00:00.000Z'),
        },
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: '2026-07-16',
          plan_exercise_id: null,
          video_id: unratedVideoId,
          text: 'Unrated',
          posted_at: new Date('2026-07-16T12:00:00.000Z'),
        },
      ])
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.items[0].video).toMatchObject({ id: ratedVideoId, rpe: '8.0' });
    expect(res.body.items[1].video).toMatchObject({ id: unratedVideoId, rpe: null });
  });

  it('keeps feedback and nulls its video fields after the attachment is deleted', async () => {
    const ctx = await makeContext();
    const videoId = await seedLinkedVideo(ctx);
    await ctx.db
      .insertInto('feedback')
      .values({
        coach_id: ids.coach,
        student_id: ids.trainee,
        day_date: '2026-07-17',
        plan_exercise_id: null,
        video_id: videoId,
        text: 'Keep this feedback',
      })
      .execute();
    await ctx.db.deleteFrom('attachments').where('id', '=', videoId).execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      text: 'Keep this feedback',
      video_id: null,
      video: null,
    });
  });

  it('lets a coach see only feedback that coach wrote', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('feedback')
      .values([
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: null,
          plan_exercise_id: null,
          text: 'Coach A feedback',
        },
        {
          coach_id: ids.otherCoach,
          student_id: ids.trainee,
          day_date: null,
          plan_exercise_id: null,
          text: 'Coach B feedback',
        },
      ])
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].text).toBe('Coach A feedback');
  });

  it('returns empty list for a bonded coach with no feedback and forbids everyone else', async () => {
    const ctx = await makeContext();

    const asBondedCoach = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.coachToken));
    // No accepted bond: coach role alone must not open the student's inbox,
    // which now carries training metadata alongside the feedback text.
    const asUnbondedCoach = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/feedback`)
      .set(auth(ctx.coachToken));
    const asStudent = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/feedback`)
      .set(auth(ctx.traineeToken));

    expect(asBondedCoach.status).toBe(200);
    expect(asBondedCoach.body).toEqual({ items: [] });
    expect(asUnbondedCoach.status).toBe(403);
    expect(asStudent.status).toBe(403);
  });
});
