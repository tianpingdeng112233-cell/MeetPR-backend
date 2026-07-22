import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext } from './helpers/studentActions';

const validBody = {
  checkin_date: '2026-06-11',
  sleep_quality: 4,
  mood: 3,
  stress: 2,
  muscle_fatigue: [
    { muscle_group: 'quad', severity: 3 },
    { muscle_group: 'core', severity: 1 },
  ],
};

describe('POST /students/me/readiness', () => {
  it('creates a check-in and returns 201 with the full check-in row', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.submitted_at).toEqual(expect.any(String));
    expect(res.body.updated_at).toEqual(expect.any(String));
    // Full row, not just {id, submitted_at}: the iOS client decodes this
    // response as a complete ReadinessCheckinDTO (spec 030 §C7).
    expect(Object.keys(res.body).sort()).toEqual([
      'checkin_date',
      'energy',
      'id',
      'mood',
      'muscle_fatigue',
      'sleep_quality',
      'stress',
      'student_id',
      'submitted_at',
      'updated_at',
    ]);
    expect(res.body).toMatchObject({
      student_id: ids.trainee,
      checkin_date: validBody.checkin_date,
      sleep_quality: validBody.sleep_quality,
      mood: validBody.mood,
      stress: validBody.stress,
      energy: null,
      muscle_fatigue: validBody.muscle_fatigue,
    });

    // POST response and a subsequent GET must serialize identically.
    const fetched = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=${validBody.checkin_date}`)
      .set(auth(ctx.traineeToken));
    expect(fetched.status).toBe(200);
    expect(fetched.body.checkin).toEqual(res.body);
  });

  it('accepts an empty muscle_fatigue array (not tired is a legal answer)', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ ...validBody, muscle_fatigue: [] });

    expect(res.status).toBe(201);
  });

  it('accepts a missing energy field from legacy clients', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.energy).toBeNull();
  });

  it('accepts severity 5 on the expanded muscle-fatigue scale', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send({
        ...validBody,
        energy: 5,
        muscle_fatigue: [{ muscle_group: 'quad', severity: 5 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.energy).toBe(5);
    expect(res.body.muscle_fatigue).toEqual([{ muscle_group: 'quad', severity: 5 }]);
  });

  it('upserts on the same day: second POST overwrites and still returns 201', async () => {
    const ctx = await makeContext();

    const first = await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send(validBody);
    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send({
        checkin_date: '2026-06-11',
        sleep_quality: 1,
        mood: 5,
        stress: 4,
        energy: 3,
        muscle_fatigue: [{ muscle_group: 'hamstring', severity: 2 }],
      });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({
      sleep_quality: 1,
      mood: 5,
      stress: 4,
      energy: 3,
      muscle_fatigue: [{ muscle_group: 'hamstring', severity: 2 }],
    });

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=2026-06-11`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.checkin).toMatchObject({
      id: first.body.id,
      student_id: ids.trainee,
      checkin_date: '2026-06-11',
      sleep_quality: 1,
      mood: 5,
      stress: 4,
      energy: 3,
      muscle_fatigue: [{ muscle_group: 'hamstring', severity: 2 }],
    });
  });

  it('keeps check-ins on different days as separate rows', async () => {
    const ctx = await makeContext();

    await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send(validBody);
    await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send({ ...validBody, checkin_date: '2026-06-12', sleep_quality: 2 });

    const day1 = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=2026-06-11`)
      .set(auth(ctx.traineeToken));
    const day2 = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=2026-06-12`)
      .set(auth(ctx.traineeToken));

    expect(day1.body.checkin.sleep_quality).toBe(4);
    expect(day2.body.checkin.sleep_quality).toBe(2);
  });

  it('rejects a coach with 403', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.coachToken))
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AUTHORIZATION_FORBIDDEN');
  });

  describe('zod rejection matrix', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['sleep_quality above scale', { ...validBody, sleep_quality: 6 }],
      ['sleep_quality below scale', { ...validBody, sleep_quality: 0 }],
      ['mood above scale', { ...validBody, mood: 6 }],
      ['stress below scale', { ...validBody, stress: 0 }],
      ['energy above scale', { ...validBody, energy: 6 }],
      ['energy below scale', { ...validBody, energy: 0 }],
      ['non-integer scale value', { ...validBody, mood: 3.5 }],
      [
        'severity above 5',
        { ...validBody, muscle_fatigue: [{ muscle_group: 'quad', severity: 6 }] },
      ],
      [
        'severity below 1',
        { ...validBody, muscle_fatigue: [{ muscle_group: 'quad', severity: 0 }] },
      ],
      [
        'muscle_group outside the 8-value whitelist',
        { ...validBody, muscle_fatigue: [{ muscle_group: 'biceps', severity: 2 }] },
      ],
      [
        'duplicate muscle_group entries',
        {
          ...validBody,
          muscle_fatigue: [
            { muscle_group: 'quad', severity: 1 },
            { muscle_group: 'quad', severity: 3 },
          ],
        },
      ],
      [
        'camelCase field names',
        {
          checkinDate: '2026-06-11',
          sleepQuality: 4,
          mood: 3,
          stress: 2,
          muscleFatigue: [],
        },
      ],
      ['malformed date', { ...validBody, checkin_date: '2026-6-1' }],
      ['non-existent calendar date', { ...validBody, checkin_date: '2026-02-30' }],
      ['missing muscle_fatigue', (({ muscle_fatigue: _mf, ...rest }) => rest)(validBody)],
    ];

    it.each(cases)('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
      const ctx = await makeContext();

      const res = await request(ctx.app)
        .post('/students/me/readiness')
        .set(auth(ctx.traineeToken))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });
});

describe('GET /students/:id/readiness', () => {
  it('returns the check-in for the student themselves', async () => {
    const ctx = await makeContext();
    await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send(validBody);

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=2026-06-11`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.checkin).toMatchObject({
      student_id: ids.trainee,
      checkin_date: '2026-06-11',
      sleep_quality: 4,
      mood: 3,
      stress: 2,
      energy: null,
      muscle_fatigue: [
        { muscle_group: 'quad', severity: 3 },
        { muscle_group: 'core', severity: 1 },
      ],
    });
    expect(res.body.checkin.submitted_at).toEqual(expect.any(String));
    expect(res.body.checkin.updated_at).toEqual(expect.any(String));
  });

  it('returns checkin: null when the day has no record', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=2026-06-11`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.checkin).toBeNull();
  });

  it('forbids another student with 403', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=2026-06-11`)
      .set(auth(ctx.otherStudentToken));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AUTHORIZATION_FORBIDDEN');
  });

  it('allows a coach with an accepted bind', async () => {
    const ctx = await makeContext();
    await request(ctx.app)
      .post('/students/me/readiness')
      .set(auth(ctx.traineeToken))
      .send(validBody);

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=2026-06-11`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.checkin.student_id).toBe(ids.trainee);
  });

  it('forbids a coach without an accepted bind with 403', async () => {
    const ctx = await makeContext();

    // ids.coach has no bind_requests row with ids.otherStudent.
    const res = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/readiness?date=2026-06-11`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AUTHORIZATION_FORBIDDEN');
  });

  it('forbids a coach whose bind is still pending', async () => {
    const ctx = await makeContext();
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.coach,
        status: 'pending',
        expired_at: new Date('2027-01-01T00:00:00.000Z'),
      })
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/readiness?date=2026-06-11`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AUTHORIZATION_FORBIDDEN');
  });

  it('returns 400 when date is missing', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when date is malformed', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/readiness?date=11-06-2026`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a non-UUID id (literal me is POST-only)', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .get('/students/me/readiness?date=2026-06-11')
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
