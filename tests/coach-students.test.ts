import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext } from './helpers/studentActions';

describe('GET /coach/students', () => {
  it('returns accepted bonded students with snake_case profile fields', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.students).toHaveLength(1);
    expect(res.body.students[0]).toMatchObject({
      id: ids.trainee,
      display_name: 'Trainee One',
      profile: {
        user_id: ids.trainee,
        display_name: 'Trainee One',
      },
      status: 'active',
      evaluation: null,
      competition_date: null,
      recent_4w: [
        { trained_days: 0, planned_days: 0 },
        { trained_days: 0, planned_days: 0 },
        { trained_days: 0, planned_days: 0 },
        { trained_days: 0, planned_days: 0 },
      ],
    });
    expect(res.body.students[0].profile.created_at).toEqual(expect.any(String));
  });

  it('keeps students without a profile row on the roster with an empty name', async () => {
    const ctx = await makeContext();
    // No DB constraint ties accepted bonds to student_profiles (only the
    // bind-request flow bootstraps the row), so the roster must not drop
    // students whose profile is missing.
    await ctx.db.deleteFrom('student_profiles').where('user_id', '=', ids.trainee).execute();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.students).toHaveLength(1);
    expect(res.body.students[0]).toMatchObject({
      id: ids.trainee,
      display_name: '',
      profile: { user_id: ids.trainee, display_name: '' },
      status: 'active',
      evaluation: null,
    });
    // With no profile row, created_at falls back to the user's registration time.
    const user = await ctx.db
      .selectFrom('users')
      .select('created_at')
      .where('id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(res.body.students[0].profile.created_at).toBe(user.created_at.toISOString());
  });

  it('returns an empty list when the coach has no accepted bonds', async () => {
    const ctx = await makeContext();
    await ctx.db.deleteFrom('bind_requests').where('coach_id', '=', ids.coach).execute();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ students: [] });
  });

  it('requires auth and coach role', async () => {
    const ctx = await makeContext();

    const noToken = await request(ctx.app).get('/coach/students');
    const asStudent = await request(ctx.app).get('/coach/students').set(auth(ctx.traineeToken));

    expect(noToken.status).toBe(401);
    expect(asStudent.status).toBe(403);
    expect(asStudent.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('marks students with an active evaluation period as in_evaluation', async () => {
    const ctx = await makeContext();
    const bond = await ctx.db
      .selectFrom('bind_requests')
      .select(['id'])
      .where('student_id', '=', ids.trainee)
      .where('coach_id', '=', ids.coach)
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('evaluation_periods')
      .values({
        student_id: ids.trainee,
        coach_id: ids.coach,
        bind_request_id: bond.id,
        expected_end_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      .execute();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    const student = res.body.students[0];
    expect(student.status).toBe('in_evaluation');
    expect(student.evaluation).toMatchObject({ overdue: false });
    expect(student.evaluation.expected_end_at).toEqual(expect.any(String));

    // Completing the evaluation flips the roster back to active.
    await ctx.db
      .updateTable('evaluation_periods')
      .set({ completed_at: new Date(), completion_type: 'coach_completed' })
      .where('student_id', '=', ids.trainee)
      .execute();
    const after = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));
    expect(after.body.students[0].status).toBe('active');
    expect(after.body.students[0].evaluation).toBeNull();
  });
});

describe('PATCH /coach/students/:id', () => {
  it('lets an accepted coach rename a student and trims the name', async () => {
    const ctx = await makeContext();

    const renamed = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '  王馨伟  ' });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: ids.trainee,
      display_name: '王馨伟',
      profile: { user_id: ids.trainee, display_name: '王馨伟' },
    });
    const profile = await ctx.db
      .selectFrom('student_profiles')
      .select('display_name')
      .where('user_id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(profile.display_name).toBe('王馨伟');
  });

  it('creates the profile row when renaming a bonded student who lacks one', async () => {
    const ctx = await makeContext();
    await ctx.db.deleteFrom('student_profiles').where('user_id', '=', ids.trainee).execute();

    const renamed = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '补建档案' });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: ids.trainee,
      display_name: '补建档案',
      profile: { user_id: ids.trainee, display_name: '补建档案' },
    });
    const profile = await ctx.db
      .selectFrom('student_profiles')
      .select('display_name')
      .where('user_id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(profile.display_name).toBe('补建档案');
  });

  it('rejects unbound students without revealing whether the profile exists', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .patch(`/coach/students/${ids.otherStudent}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '不应修改' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'COACH_STUDENT_NOT_FOUND' });
  });

  it('requires coach role and validates the new name', async () => {
    const ctx = await makeContext();

    const asStudent = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.traineeToken))
      .send({ display_name: '新名字' });
    const blank = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '   ' });
    const extraField = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '新名字', role: 'coach' });

    expect(asStudent.status).toBe(403);
    expect(blank.status).toBe(400);
    expect(extraField.status).toBe(400);
  });
});
