import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createEvaluationPeriod, ids, makeContext } from './helpers/bindEval';

const summaryBody = {
  overall_assessment: '深蹲技术稳定,硬拉触地节奏需调整。',
  training_plan: '接下来 4 周以基础力量为主,每周 3 次训练。',
  words_to_student: '第 1 阶段我们专注修复硬拉节奏。',
  notify_student: true,
};

describe('evaluation summaries', () => {
  it('first save records first_saved_at, links the evaluation period, and writes a notified version row', async () => {
    const ctx = await makeContext();
    const { evaluationId } = await createEvaluationPeriod(ctx);

    const saved = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken))
      .send(summaryBody);

    expect(saved.status).toBe(200);
    expect(saved.body.student_id).toBe(ids.boundStudent);
    expect(saved.body.coach_id).toBe(ids.coach);
    expect(saved.body.evaluation_period_id).toBe(evaluationId);
    expect(saved.body.overall_assessment).toBe(summaryBody.overall_assessment);
    expect(saved.body.first_saved_at).toBe(saved.body.last_updated_at);
    expect(saved.body.is_active).toBe(true);

    const versions = await ctx.db
      .selectFrom('student_evaluation_versions')
      .selectAll()
      .where('evaluation_id', '=', saved.body.id)
      .execute();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.notified_student).toBe(true);
  });

  it('re-save keeps first_saved_at, appends a version, and honors notify_student=false', async () => {
    const ctx = await makeContext();

    const first = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken))
      .send(summaryBody);

    const second = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken))
      .send({
        ...summaryBody,
        overall_assessment: '更新后的整体评估。',
        words_to_student: null,
        notify_student: false,
      });

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.first_saved_at).toBe(first.body.first_saved_at);
    expect(second.body.overall_assessment).toBe('更新后的整体评估。');
    expect(second.body.words_to_student).toBeNull();

    const versions = await ctx.db
      .selectFrom('student_evaluation_versions')
      .selectAll()
      .where('evaluation_id', '=', first.body.id)
      .orderBy('saved_at', 'asc')
      .execute();
    expect(versions).toHaveLength(2);
    expect(versions[0]?.notified_student).toBe(true);
    expect(versions[1]?.notified_student).toBe(false);
  });

  it('summary works on the skip-evaluation path with a null evaluation_period_id', async () => {
    const ctx = await makeContext();

    const saved = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken))
      .send(summaryBody);

    expect(saved.status).toBe(200);
    expect(saved.body.evaluation_period_id).toBeNull();
  });

  it('blocks coaches without an accepted bond', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.otherCoachToken))
      .send(summaryBody);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('AUTHORIZATION_FORBIDDEN');
  });

  it('student reads own summary; bonded coach reads own row; strangers are blocked', async () => {
    const ctx = await makeContext();
    await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken))
      .send(summaryBody);

    const studentRead = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.boundStudentToken));
    expect(studentRead.status).toBe(200);
    expect(studentRead.body.training_plan).toBe(summaryBody.training_plan);

    const coachRead = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken));
    expect(coachRead.status).toBe(200);

    const strangerCoach = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.otherCoachToken));
    expect(strangerCoach.status).toBe(403);

    const otherStudent = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.freeStudentToken));
    expect(otherStudent.status).toBe(403);
  });

  it('404s when no summary exists yet', async () => {
    const ctx = await makeContext();

    const studentRead = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.boundStudentToken));
    expect(studentRead.status).toBe(404);
    expect(studentRead.body.error).toBe('EVALUATION_SUMMARY_NOT_FOUND');
  });

  it('rejects camelCase fields and missing required fields', async () => {
    const ctx = await makeContext();

    const camel = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken))
      .send({
        overallAssessment: 'x',
        trainingPlan: 'y',
        notifyStudent: true,
      });
    const missing = await request(ctx.app)
      .put(`/coach/students/${ids.boundStudent}/evaluation-summary`)
      .set(auth(ctx.coachToken))
      .send({ overall_assessment: 'x', notify_student: true });

    expect(camel.status).toBe(400);
    expect(camel.body.error).toBe('VALIDATION_ERROR');
    expect(missing.status).toBe(400);
  });
});
