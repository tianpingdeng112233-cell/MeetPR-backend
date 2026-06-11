import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  createDraftPlan,
  createEvaluationPeriod,
  ids,
  makeContext,
} from './helpers/bindEval';

describe('evaluation periods', () => {
  it('returns the active evaluation from both coach and student views', async () => {
    const ctx = await makeContext();
    await createEvaluationPeriod(ctx);

    const coachView = await request(ctx.app)
      .get(`/coach/students/${ids.boundStudent}/evaluation`)
      .set(auth(ctx.coachToken));
    const studentView = await request(ctx.app)
      .get('/students/me/evaluation')
      .set(auth(ctx.boundStudentToken));

    expect(coachView.status).toBe(200);
    expect(coachView.body.in_progress).toBe(true);
    expect(coachView.body.overdue).toBe(false);
    expect(coachView.body.completed_at).toBeNull();
    expect(studentView.status).toBe(200);
    expect(studentView.body.id).toBe(coachView.body.id);
  });

  it('marks overdue at read time without auto-completing', async () => {
    const ctx = await makeContext();
    await createEvaluationPeriod(ctx, { expectedEndAt: new Date(Date.now() - 3600 * 1000) });

    const view = await request(ctx.app)
      .get(`/coach/students/${ids.boundStudent}/evaluation`)
      .set(auth(ctx.coachToken));

    expect(view.status).toBe(200);
    expect(view.body.in_progress).toBe(true);
    expect(view.body.overdue).toBe(true);
    expect(view.body.completed_at).toBeNull();

    const row = await ctx.db.selectFrom('evaluation_periods').selectAll().executeTakeFirstOrThrow();
    expect(row.completed_at).toBeNull();
  });

  it('404s when no evaluation exists', async () => {
    const ctx = await makeContext();

    const coachView = await request(ctx.app)
      .get(`/coach/students/${ids.boundStudent}/evaluation`)
      .set(auth(ctx.coachToken));
    const studentView = await request(ctx.app)
      .get('/students/me/evaluation')
      .set(auth(ctx.boundStudentToken));

    expect(coachView.status).toBe(404);
    expect(coachView.body.error).toBe('EVALUATION_NOT_FOUND');
    expect(studentView.status).toBe(404);
  });

  it('coach completes own evaluation; re-complete conflicts; foreign coach 404s', async () => {
    const ctx = await makeContext();
    const { evaluationId } = await createEvaluationPeriod(ctx);

    const foreign = await request(ctx.app)
      .post(`/coach/evaluations/${evaluationId}/complete`)
      .set(auth(ctx.otherCoachToken));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('EVALUATION_NOT_FOUND');

    const complete = await request(ctx.app)
      .post(`/coach/evaluations/${evaluationId}/complete`)
      .set(auth(ctx.coachToken));
    expect(complete.status).toBe(200);
    expect(complete.body.completed_at).not.toBeNull();
    expect(complete.body.completion_type).toBe('coach_completed');
    expect(complete.body.in_progress).toBe(false);
    expect(complete.body.overdue).toBe(false);

    const again = await request(ctx.app)
      .post(`/coach/evaluations/${evaluationId}/complete`)
      .set(auth(ctx.coachToken));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('EVALUATION_ALREADY_COMPLETED');
  });
});

describe('publish evaluation hard gate', () => {
  it('blocks publishing a regular plan while an evaluation is active', async () => {
    const ctx = await makeContext();
    await createEvaluationPeriod(ctx);
    const { planId } = await createDraftPlan(ctx, { kind: 'regular', planWeeks: 4 });

    const publish = await request(ctx.app)
      .post(`/plans/${planId}/publish`)
      .set(auth(ctx.coachToken));

    expect(publish.status).toBe(403);
    expect(publish.body).toEqual({ error: 'EVALUATION_IN_PROGRESS' });

    const plan = await ctx.db
      .selectFrom('plans')
      .select(['status'])
      .where('id', '=', planId)
      .executeTakeFirstOrThrow();
    expect(plan.status).toBe('draft');
  });

  it('allows publishing a 1-week adaptation plan during the evaluation', async () => {
    const ctx = await makeContext();
    await createEvaluationPeriod(ctx);
    const { planId } = await createDraftPlan(ctx, { kind: 'adaptation', planWeeks: 1 });

    const publish = await request(ctx.app)
      .post(`/plans/${planId}/publish`)
      .set(auth(ctx.coachToken));

    expect(publish.status).toBe(200);
    expect(publish.body.status).toBe('published');
    expect(publish.body.kind).toBe('adaptation');
  });

  it('allows regular publishing once the evaluation is completed', async () => {
    const ctx = await makeContext();
    const { evaluationId } = await createEvaluationPeriod(ctx);
    await request(ctx.app)
      .post(`/coach/evaluations/${evaluationId}/complete`)
      .set(auth(ctx.coachToken));

    const { planId } = await createDraftPlan(ctx, { kind: 'regular', planWeeks: 4 });
    const publish = await request(ctx.app)
      .post(`/plans/${planId}/publish`)
      .set(auth(ctx.coachToken));

    expect(publish.status).toBe(200);
    expect(publish.body.status).toBe('published');
  });

  it('allows regular publishing when no evaluation period exists', async () => {
    const ctx = await makeContext();
    const { planId } = await createDraftPlan(ctx, { kind: 'regular', planWeeks: 4 });

    const publish = await request(ctx.app)
      .post(`/plans/${planId}/publish`)
      .set(auth(ctx.coachToken));
    expect(publish.status).toBe(200);
  });

  it('does not let another coach evaluation block this coach', async () => {
    const ctx = await makeContext();
    // otherCoach has an active evaluation with the same student.
    const bindRequest = await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.boundStudent,
        coach_id: ids.otherCoach,
        status: 'accepted',
        expired_at: new Date('2026-06-08T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await createEvaluationPeriod(ctx, {
      coachId: ids.otherCoach,
      bindRequestId: bindRequest.id,
    });

    const { planId } = await createDraftPlan(ctx, { kind: 'regular', planWeeks: 4 });
    const publish = await request(ctx.app)
      .post(`/plans/${planId}/publish`)
      .set(auth(ctx.coachToken));
    expect(publish.status).toBe(200);
  });

  it('rejects creating an adaptation plan longer than 1 week (zod gate)', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app).post('/plans').set(auth(ctx.coachToken)).send({
      trainee_id: ids.boundStudent,
      name: 'Bad Adaptation',
      start_date: '2026-06-15',
      end_date: '2026-07-12',
      plan_weeks: 4,
      source: 'coach',
      kind: 'adaptation',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('creates plans with kind defaulting to regular and round-trips kind in responses', async () => {
    const ctx = await makeContext();

    const regular = await request(ctx.app).post('/plans').set(auth(ctx.coachToken)).send({
      trainee_id: ids.boundStudent,
      name: 'Default Kind',
      start_date: '2026-06-15',
      end_date: '2026-07-12',
      plan_weeks: 4,
      source: 'coach',
    });
    const adaptation = await request(ctx.app).post('/plans').set(auth(ctx.coachToken)).send({
      trainee_id: ids.boundStudent,
      name: 'Adaptation Week',
      start_date: '2026-06-15',
      end_date: '2026-06-21',
      plan_weeks: 1,
      source: 'coach',
      kind: 'adaptation',
    });

    expect(regular.status).toBe(201);
    expect(regular.body.kind).toBe('regular');
    expect(adaptation.status).toBe(201);
    expect(adaptation.body.kind).toBe('adaptation');
  });
});
