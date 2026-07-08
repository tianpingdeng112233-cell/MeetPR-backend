import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext, type TestContext } from './helpers/bindEval';

const fullProfile = {
  unit_preference: 'kg',
  gender: 'male',
  birth_date: '2001-03-12',
  height_cm: '178',
  weight_kg: '83',
  training_years: 3,
  squat_stance: 'low_bar',
  deadlift_style: 'conventional',
  bench_grip: 'standard',
  squat_1rm_kg: '180',
  bench_1rm_kg: '120',
  deadlift_1rm_kg: '220',
  training_days: ['mon', 'wed', 'fri', 'sat'],
  gym_tier: 'commercial',
  equipment_overrides: ['smith_machine'],
  daily_life_intensity: 3,
  life_stress: 4,
  recovery_speed: 3,
  sleep_hours: 3,
  muscle_groups_to_strengthen: ['quad', 'hamstring', 'shoulder'],
  injury_notes: '左肩撞击综合征',
  injury_areas: ['shoulder'],
  is_competing: true,
  competition_date: '2026-07-25',
  target_weight_class: 'IPF 83kg',
  note_to_coach: '想突破 200kg 深蹲',
};

async function putOnboarding(ctx: TestContext, token: string, body: Record<string, unknown>) {
  return request(ctx.app).put('/students/me/onboarding').set(auth(token)).send(body);
}

describe('student onboarding profile', () => {
  it('upserts step by step and merges partial submissions', async () => {
    const ctx = await makeContext();

    const step1 = await putOnboarding(ctx, ctx.boundStudentToken, {
      unit_preference: 'kg',
      gender: 'male',
      birth_date: '2001-03-12',
      height_cm: '178',
      weight_kg: '83.5',
    });
    expect(step1.status).toBe(200);
    expect(step1.body.unit_preference).toBe('kg');
    expect(step1.body.weight_kg).toBe('83.50');
    expect(step1.body.height_cm).toBe('178.0');
    expect(step1.body.training_years).toBeNull();
    expect(step1.body.completed_at).toBeNull();

    const step2 = await putOnboarding(ctx, ctx.boundStudentToken, {
      training_years: 3,
      squat_stance: 'low_bar',
      deadlift_style: 'conventional',
    });
    expect(step2.status).toBe(200);
    // Step 1 fields survive the step 2 upsert.
    expect(step2.body.unit_preference).toBe('kg');
    expect(step2.body.training_years).toBe(3);
    expect(step2.body.squat_stance).toBe('low_bar');
    expect(step2.body.bench_grip).toBeNull();
  });

  it('accepts an empty body as a row-creating no-op', async () => {
    const ctx = await makeContext();

    const response = await putOnboarding(ctx, ctx.boundStudentToken, {});
    expect(response.status).toBe(200);
    expect(response.body.user_id).toBe(ids.boundStudent);
    expect(response.body.completed_at).toBeNull();
  });

  it('replaces upload attachments wholesale', async () => {
    const ctx = await makeContext();
    const a = '90000000-0000-4000-8000-000000000001';
    const b = '90000000-0000-4000-8000-000000000002';
    const c = '90000000-0000-4000-8000-000000000003';

    const first = await putOnboarding(ctx, ctx.boundStudentToken, {
      upload_attachment_ids: [a, b],
    });
    expect(first.status).toBe(200);
    expect(first.body.upload_attachment_ids).toEqual([a, b]);

    const second = await putOnboarding(ctx, ctx.boundStudentToken, {
      upload_attachment_ids: [c],
    });
    expect(second.body.upload_attachment_ids).toEqual([c]);

    const cleared = await putOnboarding(ctx, ctx.boundStudentToken, {
      upload_attachment_ids: [],
    });
    expect(cleared.body.upload_attachment_ids).toEqual([]);
  });

  it('completes only when all required fields are present, with missing_fields detail', async () => {
    const ctx = await makeContext();

    const tooEarly = await request(ctx.app)
      .post('/students/me/onboarding/complete')
      .set(auth(ctx.boundStudentToken));
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.error).toBe('ONBOARDING_INCOMPLETE');
    expect(tooEarly.body.missing_fields).toContain('unit_preference');

    const { competition_date, ...withoutCompetitionDate } = fullProfile;
    await putOnboarding(ctx, ctx.boundStudentToken, withoutCompetitionDate);

    // is_competing=true makes competition_date conditionally required.
    const missingDate = await request(ctx.app)
      .post('/students/me/onboarding/complete')
      .set(auth(ctx.boundStudentToken));
    expect(missingDate.status).toBe(422);
    expect(missingDate.body.missing_fields).toEqual(['competition_date']);

    await putOnboarding(ctx, ctx.boundStudentToken, { competition_date });
    const completed = await request(ctx.app)
      .post('/students/me/onboarding/complete')
      .set(auth(ctx.boundStudentToken));
    expect(completed.status).toBe(200);
    expect(completed.body.completed_at).not.toBeNull();

    // Idempotent re-complete keeps the original timestamp.
    const again = await request(ctx.app)
      .post('/students/me/onboarding/complete')
      .set(auth(ctx.boundStudentToken));
    expect(again.status).toBe(200);
    expect(again.body.completed_at).toBe(completed.body.completed_at);
  });

  it('allows completion when training days are uncertain', async () => {
    const ctx = await makeContext();

    await putOnboarding(ctx, ctx.boundStudentToken, {
      ...fullProfile,
      training_days: null,
    });

    const completed = await request(ctx.app)
      .post('/students/me/onboarding/complete')
      .set(auth(ctx.boundStudentToken));
    expect(completed.status).toBe(200);
    expect(completed.body.training_days).toBeNull();
    expect(completed.body.completed_at).not.toBeNull();
  });

  it('locks the three 1RM fields after completion; coach endpoint stays authoritative', async () => {
    const ctx = await makeContext();
    await putOnboarding(ctx, ctx.boundStudentToken, fullProfile);
    await request(ctx.app)
      .post('/students/me/onboarding/complete')
      .set(auth(ctx.boundStudentToken));

    const lockedPut = await putOnboarding(ctx, ctx.boundStudentToken, { squat_1rm_kg: '190' });
    expect(lockedPut.status).toBe(403);
    expect(lockedPut.body).toEqual({ error: 'ONE_RM_LOCKED' });

    // Non-1RM fields stay editable after completion.
    const benignPut = await putOnboarding(ctx, ctx.boundStudentToken, { weight_kg: '84' });
    expect(benignPut.status).toBe(200);
    expect(benignPut.body.weight_kg).toBe('84.00');
    expect(benignPut.body.squat_1rm_kg).toBe('180.00');

    // Coach endpoint is the only writer for locked 1RMs.
    const coachPut = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/one-rm`)
      .set(auth(ctx.coachToken))
      .send({ squat_1rm_kg: '190', deadlift_1rm_kg: '225' });
    expect(coachPut.status).toBe(200);
    expect(coachPut.body.squat_1rm_kg).toBe('190.00');
    expect(coachPut.body.bench_1rm_kg).toBe('120.00');
    expect(coachPut.body.deadlift_1rm_kg).toBe('225.00');

    const unbondedCoach = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/one-rm`)
      .set(auth(ctx.otherCoachToken))
      .send({ squat_1rm_kg: '500' });
    expect(unbondedCoach.status).toBe(403);

    const emptyBody = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/one-rm`)
      .set(auth(ctx.coachToken))
      .send({});
    expect(emptyBody.status).toBe(400);
  });

  it('allows 1RM edits while onboarding is still incomplete', async () => {
    const ctx = await makeContext();
    await putOnboarding(ctx, ctx.boundStudentToken, { squat_1rm_kg: '170' });

    const update = await putOnboarding(ctx, ctx.boundStudentToken, { squat_1rm_kg: '175' });
    expect(update.status).toBe(200);
    expect(update.body.squat_1rm_kg).toBe('175.00');
  });

  it('enforces the read authorization matrix', async () => {
    const ctx = await makeContext();
    await putOnboarding(ctx, ctx.boundStudentToken, { gender: 'male' });

    // self
    const self = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/onboarding`)
      .set(auth(ctx.boundStudentToken));
    expect(self.status).toBe(200);

    // bonded coach
    const bonded = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/onboarding`)
      .set(auth(ctx.coachToken));
    expect(bonded.status).toBe(200);
    expect(bonded.body.gender).toBe('male');

    // stranger coach
    const stranger = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/onboarding`)
      .set(auth(ctx.otherCoachToken));
    expect(stranger.status).toBe(403);

    // another student
    const peer = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/onboarding`)
      .set(auth(ctx.freeStudentToken));
    expect(peer.status).toBe(403);

    // live-pending coach (receive queue full-profile view, D16)
    const code = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.otherCoachToken))
      .send({ type: 'personal_permanent' });
    await putOnboarding(ctx, ctx.freeStudentToken, { gender: 'female' });
    await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: code.body.code, display_name: '李四' });
    const pendingCoach = await request(ctx.app)
      .get(`/students/${ids.freeStudent}/onboarding`)
      .set(auth(ctx.otherCoachToken));
    expect(pendingCoach.status).toBe(200);
    expect(pendingCoach.body.gender).toBe('female');

    // ...but not the uninvolved coach
    const uninvolved = await request(ctx.app)
      .get(`/students/${ids.freeStudent}/onboarding`)
      .set(auth(ctx.coachToken));
    expect(uninvolved.status).toBe(403);
  });

  it('404s for a missing profile row and rejects invalid tokens/values', async () => {
    const ctx = await makeContext();

    const missing = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/onboarding`)
      .set(auth(ctx.boundStudentToken));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('ONBOARDING_NOT_FOUND');

    const badDay = await putOnboarding(ctx, ctx.boundStudentToken, { training_days: ['mon'] });
    expect(badDay.status).toBe(400); // min 2 days

    const badMuscles = await putOnboarding(ctx, ctx.boundStudentToken, {
      muscle_groups_to_strengthen: ['quad', 'glute', 'hamstring', 'shoulder'],
    });
    expect(badMuscles.status).toBe(400); // max 3

    const badScale = await putOnboarding(ctx, ctx.boundStudentToken, { life_stress: 6 });
    expect(badScale.status).toBe(400);

    const camel = await putOnboarding(ctx, ctx.boundStudentToken, { unitPreference: 'kg' });
    expect(camel.status).toBe(400);
    expect(camel.body.error).toBe('VALIDATION_ERROR');

    const asCoach = await request(ctx.app)
      .put('/students/me/onboarding')
      .set(auth(ctx.coachToken))
      .send({ gender: 'male' });
    expect(asCoach.status).toBe(403);
  });

  it('supports self_train students through the same wizard', async () => {
    const ctx = await makeContext();

    const response = await putOnboarding(ctx, ctx.selfTrainStudentToken, {
      unit_preference: 'lb',
    });
    expect(response.status).toBe(200);
    expect(response.body.unit_preference).toBe('lb');
  });
});
