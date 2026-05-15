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
    });
    expect(res.body.students[0].profile.created_at).toEqual(expect.any(String));
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
});
