import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { shanghaiTrainingDay } from '../src/utils/date';
import { auth, ids, makeContext, type TestContext } from './helpers/studentActions';

const COMPETITION_SQUAT_ID = '2f708759-821a-4d5b-9fde-32f60bc2b7f2';
const COMPETITION_DEADLIFT_ID = '4a912d5c-2248-4f3d-80ec-384f8360c315';

function daysFromToday(offset: number): string {
  const date = new Date(`${shanghaiTrainingDay()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function atTenUtc(date: string, minute = 0): Date {
  return new Date(`${date}T10:${String(minute).padStart(2, '0')}:00.000Z`);
}

function weekStartMonday(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function itemAt<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing fixture item at index ${String(index)}`);
  return item;
}

async function addExercise(
  ctx: TestContext,
  id: string,
  name: string,
  family: 'squat' | 'bench' | 'deadlift',
  options: {
    isCompetitionLift?: boolean;
    competitionStance?: 'low_bar' | 'high_bar' | 'conventional' | 'sumo' | null;
  } = {},
) {
  await ctx.db
    .insertInto('exercises')
    .values({
      id,
      name,
      exercise_type: 'main_lift',
      main_lift_family: family,
      is_competition_lift: options.isCompetitionLift ?? true,
      competition_stance: options.competitionStance ?? null,
      muscle_groups: family === 'squat' ? ['quad'] : ['hamstring'],
      equipment: ['barbell'],
      movement_pattern: [],
    })
    .execute();
}

async function addPlanExercise(
  ctx: TestContext,
  exerciseId: string,
  coachId = ids.coach,
): Promise<string[]> {
  const plan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: coachId,
      trainee_id: ids.trainee,
      name: 'Stats Block',
      start_date: daysFromToday(-22),
      end_date: daysFromToday(5),
      plan_weeks: 4,
      source: 'coach',
      status: 'published',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const days = await ctx.db
    .insertInto('plan_days')
    .values(
      Array.from({ length: 6 }, (_, index) => ({
        plan_id: plan.id,
        day_of_week: index + 1,
        week_number: 1,
        sort_order: 0,
      })),
    )
    .returning('id')
    .execute();
  const planExercises = await ctx.db
    .insertInto('plan_exercises')
    .values(
      days.map((day) => ({
        plan_day_id: day.id,
        exercise_id: exerciseId,
        is_main_lift: true,
        sort_order: 0,
      })),
    )
    .returning('id')
    .execute();
  return planExercises.map((exercise) => exercise.id);
}

describe('GET /coach/students/:id/exercise-stats', () => {
  it('resolves e1RM and references from the student competition stance', async () => {
    const ctx = await makeContext();
    const exercises = [
      ['71000000-0000-4000-8000-000000000001', '低杠位深蹲', 'squat', false, 'low_bar'],
      ['71000000-0000-4000-8000-000000000002', '高杠位深蹲', 'squat', false, 'high_bar'],
      ['71000000-0000-4000-8000-000000000003', '传统硬拉', 'deadlift', true, 'conventional'],
      ['71000000-0000-4000-8000-000000000004', '相扑硬拉', 'deadlift', true, 'sumo'],
      ['71000000-0000-4000-8000-000000000005', '竞技深蹲', 'squat', true, null],
      ['71000000-0000-4000-8000-000000000006', '竞技卧推', 'bench', true, null],
      ['71000000-0000-4000-8000-000000000007', '暂停深蹲', 'squat', false, null],
      ['71000000-0000-4000-8000-000000000008', '罗马尼亚硬拉', 'deadlift', false, null],
    ] as const;

    for (const [id, name, family, isCompetitionLift, competitionStance] of exercises) {
      await addExercise(ctx, id, name, family, { isCompetitionLift, competitionStance });
      const [planExerciseId] = await addPlanExercise(ctx, id);
      if (planExerciseId === undefined) throw new Error('Missing plan exercise fixture');
      await ctx.db
        .insertInto('set_logs')
        .values({
          student_id: ids.trainee,
          plan_exercise_id: planExerciseId,
          exercise_id: id,
          logged_date: daysFromToday(-1),
          set_index: 0,
          weight_kg: '100.00',
          reps: 5,
          completed: true,
          logged_at: atTenUtc(daysFromToday(-1)),
        })
        .execute();
    }
    await ctx.db
      .insertInto('student_onboarding_profiles')
      .values({
        user_id: ids.trainee,
        squat_stance: 'low_bar',
        deadlift_style: 'conventional',
        squat_1rm_kg: '180.00',
        bench_1rm_kg: '120.00',
        deadlift_1rm_kg: '220.00',
      })
      .execute();

    const detail = async (exerciseId: string) => {
      const response = await request(ctx.app)
        .get(`/coach/students/${ids.trainee}/exercise-stats?exercise_id=${exerciseId}`)
        .set(auth(ctx.coachToken));
      expect(response.status).toBe(200);
      return response.body as { e1rm: unknown; one_rm_reference: string | null };
    };
    const expectEligible = async (exerciseId: string, reference: string) => {
      const body = await detail(exerciseId);
      expect(body.e1rm).not.toBeNull();
      expect(body.one_rm_reference).toBe(reference);
    };
    const expectIneligible = async (exerciseId: string) => {
      const body = await detail(exerciseId);
      expect(body.e1rm).toBeNull();
      expect(body.one_rm_reference).toBeNull();
    };

    await expectEligible(exercises[0][0], '180.00');
    await expectIneligible(exercises[1][0]);
    await ctx.db
      .updateTable('student_onboarding_profiles')
      .set({ squat_stance: 'high_bar' })
      .where('user_id', '=', ids.trainee)
      .execute();
    await expectIneligible(exercises[0][0]);
    await expectEligible(exercises[1][0], '180.00');

    await expectEligible(exercises[2][0], '220.00');
    await expectIneligible(exercises[3][0]);
    await ctx.db
      .updateTable('student_onboarding_profiles')
      .set({ deadlift_style: 'sumo' })
      .where('user_id', '=', ids.trainee)
      .execute();
    await expectIneligible(exercises[2][0]);
    await expectEligible(exercises[3][0], '220.00');
    await ctx.db
      .updateTable('student_onboarding_profiles')
      .set({ deadlift_style: 'both' })
      .where('user_id', '=', ids.trainee)
      .execute();
    await expectEligible(exercises[2][0], '220.00');
    await expectEligible(exercises[3][0], '220.00');

    await ctx.db
      .updateTable('student_onboarding_profiles')
      .set({ squat_stance: null, deadlift_style: null })
      .where('user_id', '=', ids.trainee)
      .execute();
    await expectEligible(exercises[0][0], '180.00');
    await expectEligible(exercises[1][0], '180.00');
    await expectEligible(exercises[2][0], '220.00');
    await expectEligible(exercises[3][0], '220.00');
    await expectEligible(exercises[4][0], '180.00');
    await expectEligible(exercises[5][0], '120.00');
    await expectIneligible(exercises[6][0]);
    await expectIneligible(exercises[7][0]);
  });

  it('returns a resolved 1RM reference for a competition lift with no logs', async () => {
    const ctx = await makeContext();
    const lowBarId = '73000000-0000-4000-8000-000000000001';
    const pausedSquatId = '73000000-0000-4000-8000-000000000002';
    await addExercise(ctx, lowBarId, '低杠位深蹲', 'squat', {
      isCompetitionLift: false,
      competitionStance: 'low_bar',
    });
    await addExercise(ctx, pausedSquatId, '暂停深蹲', 'squat', {
      isCompetitionLift: false,
      competitionStance: null,
    });
    await ctx.db
      .insertInto('student_onboarding_profiles')
      .values({
        user_id: ids.trainee,
        squat_stance: 'low_bar',
        squat_1rm_kg: '180.00',
      })
      .execute();

    const detail = async (exerciseId: string) => {
      const response = await request(ctx.app)
        .get(`/coach/students/${ids.trainee}/exercise-stats?exercise_id=${exerciseId}`)
        .set(auth(ctx.coachToken));
      expect(response.status).toBe(200);
      return response.body as { e1rm: unknown; one_rm_reference: string | null };
    };

    expect(await detail(lowBarId)).toMatchObject({ e1rm: null, one_rm_reference: '180.00' });
    expect(await detail(pausedSquatId)).toMatchObject({ e1rm: null, one_rm_reference: null });

    await ctx.db
      .updateTable('student_onboarding_profiles')
      .set({ squat_stance: 'high_bar' })
      .where('user_id', '=', ids.trainee)
      .execute();
    expect(await detail(lowBarId)).toMatchObject({ e1rm: null, one_rm_reference: null });
  });

  it('returns the overview scoped to an accepted coach bond and owned plan logs', async () => {
    const ctx = await makeContext();
    await addExercise(ctx, COMPETITION_SQUAT_ID, '竞技深蹲', 'squat');
    const ownedExercises = await addPlanExercise(ctx, COMPETITION_SQUAT_ID);
    const otherExercises = await addPlanExercise(ctx, COMPETITION_SQUAT_ID, ids.otherCoach);
    await ctx.db
      .insertInto('student_onboarding_profiles')
      .values({
        user_id: ids.trainee,
        squat_1rm_kg: '180.00',
        bench_1rm_kg: '120.00',
        deadlift_1rm_kg: '220.00',
      })
      .execute();
    await ctx.db
      .insertInto('set_logs')
      .values([
        {
          student_id: ids.trainee,
          plan_exercise_id: itemAt(ownedExercises, 0),
          exercise_id: COMPETITION_SQUAT_ID,
          logged_date: daysFromToday(-2),
          set_index: 0,
          weight_kg: '100.00',
          reps: 5,
          completed: true,
          failed: false,
          assumed: false,
          logged_at: atTenUtc(daysFromToday(-2)),
        },
        {
          student_id: ids.trainee,
          plan_exercise_id: itemAt(ownedExercises, 1),
          exercise_id: COMPETITION_SQUAT_ID,
          logged_date: daysFromToday(-7),
          set_index: 0,
          weight_kg: '95.00',
          reps: 5,
          completed: true,
          failed: false,
          assumed: true,
          logged_at: atTenUtc(daysFromToday(-7)),
        },
        {
          student_id: ids.trainee,
          plan_exercise_id: itemAt(otherExercises, 0),
          exercise_id: COMPETITION_SQUAT_ID,
          logged_date: daysFromToday(-1),
          set_index: 0,
          weight_kg: '200.00',
          reps: 1,
          completed: true,
          failed: false,
          assumed: false,
          logged_at: atTenUtc(daysFromToday(-1)),
        },
      ])
      .execute();

    const response = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/exercise-stats`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      exercises: [
        {
          exercise_id: COMPETITION_SQUAT_ID,
          name: '竞技深蹲',
          session_count: 2,
          last_logged_at: atTenUtc(daysFromToday(-2)).toISOString(),
        },
      ],
      one_rm: { squat: '180.00', bench: '120.00', deadlift: '220.00' },
      last_trained_at: atTenUtc(daysFromToday(-2)).toISOString(),
      recent_4w: { trained_days: 1, total_planned_days: 6, completion_rate: 0.1667 },
      e1rm_series: {
        squat: {
          points: [{ date: daysFromToday(-2), value: '116.67' }],
          trend: 'new',
        },
        bench: { points: [], trend: 'new' },
        deadlift: { points: [], trend: 'new' },
      },
      weekly_volume: [
        {
          week_start: weekStartMonday(daysFromToday(-2)),
          volume_kg: '500.00',
          avg_rpe: null,
          volume_by_family: {
            squat: '500.00',
            bench: '0.00',
            deadlift: '0.00',
            other: '0.00',
          },
        },
      ],
    });
  });

  it('returns PRs, five recent sessions, set-count buckets, e1RM, and video flags', async () => {
    const ctx = await makeContext();
    await addExercise(ctx, COMPETITION_SQUAT_ID, '竞技深蹲', 'squat');
    const planExerciseIds = await addPlanExercise(ctx, COMPETITION_SQUAT_ID);
    await ctx.db
      .insertInto('student_onboarding_profiles')
      .values({ user_id: ids.trainee, squat_1rm_kg: '180.00' })
      .execute();

    const rows = await ctx.db
      .insertInto('set_logs')
      .values([
        {
          student_id: ids.trainee,
          plan_exercise_id: itemAt(planExerciseIds, 0),
          exercise_id: COMPETITION_SQUAT_ID,
          logged_date: daysFromToday(-22),
          set_index: 0,
          weight_kg: '100.00',
          reps: 5,
          completed: true,
          failed: false,
          assumed: true,
          logged_at: atTenUtc(daysFromToday(-22)),
        },
        {
          student_id: ids.trainee,
          plan_exercise_id: itemAt(planExerciseIds, 1),
          exercise_id: COMPETITION_SQUAT_ID,
          logged_date: daysFromToday(-7),
          set_index: 0,
          weight_kg: '95.00',
          reps: 5,
          rpe: '8.0',
          completed: true,
          failed: false,
          assumed: false,
          logged_at: atTenUtc(daysFromToday(-7)),
        },
        {
          student_id: ids.trainee,
          plan_exercise_id: itemAt(planExerciseIds, 1),
          exercise_id: COMPETITION_SQUAT_ID,
          logged_date: daysFromToday(-7),
          set_index: 1,
          weight_kg: '90.00',
          reps: 5,
          rpe: '6.5',
          completed: true,
          failed: false,
          assumed: false,
          logged_at: atTenUtc(daysFromToday(-7), 5),
        },
        {
          student_id: ids.trainee,
          plan_exercise_id: itemAt(planExerciseIds, 2),
          exercise_id: COMPETITION_SQUAT_ID,
          logged_date: daysFromToday(-2),
          set_index: 0,
          weight_kg: '110.00',
          reps: 3,
          rpe: '9.0',
          completed: true,
          failed: false,
          assumed: false,
          e1rm_confidence: 'low',
          logged_at: atTenUtc(daysFromToday(-2)),
        },
      ])
      .returning(['id', 'logged_date'])
      .execute();
    const videoLog = itemAt(rows, 1);
    await ctx.db
      .insertInto('attachments')
      .values({
        owner_id: ids.trainee,
        kind: 'set_video',
        oss_key: 'stats/video.mp4',
        content_type: 'video/mp4',
        size_bytes: 100,
        set_log_id: videoLog.id,
        source_coach_id: ids.coach,
        part_count: 1,
        status: 'ready',
      })
      .execute();

    const response = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/exercise-stats?exercise_id=${COMPETITION_SQUAT_ID}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.rep_prs).toEqual([
      {
        reps: 3,
        weight_kg: '110.00',
        logged_at: atTenUtc(daysFromToday(-2)).toISOString(),
        source: 'logged',
      },
      {
        reps: 5,
        weight_kg: '100.00',
        logged_at: atTenUtc(daysFromToday(-22)).toISOString(),
        source: 'imported',
      },
    ]);
    expect(response.body.recent_sessions).toHaveLength(3);
    expect(response.body.recent_sessions[1]).toMatchObject({
      date: daysFromToday(-7),
      sets: [
        expect.objectContaining({ set_index: 0, has_video: true, assumed: false }),
        expect.objectContaining({ set_index: 1, has_video: false, rpe: '6.5' }),
      ],
    });
    expect(response.body.by_set_count['1']).toHaveLength(2);
    expect(response.body.by_set_count['2']).toEqual([
      {
        date: daysFromToday(-7),
        set_count: 2,
        best_weight_kg: '95.00',
        total_reps: 10,
        completed_sets: 2,
      },
    ]);
    expect(response.body.e1rm).toEqual({
      value: '121.79',
      computed_at: atTenUtc(daysFromToday(-7)).toISOString(),
    });
    expect(response.body.one_rm_reference).toBe('180.00');
  });

  it('applies the deadlift rep ceiling and rejects unbound/non-coach callers', async () => {
    const ctx = await makeContext();
    await addExercise(ctx, COMPETITION_DEADLIFT_ID, '传统硬拉', 'deadlift');
    const planExerciseIds = await addPlanExercise(ctx, COMPETITION_DEADLIFT_ID);
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.trainee,
        plan_exercise_id: itemAt(planExerciseIds, 0),
        exercise_id: COMPETITION_DEADLIFT_ID,
        logged_date: daysFromToday(-2),
        set_index: 0,
        weight_kg: '150.00',
        reps: 6,
        rpe: '9.0',
        completed: true,
      })
      .execute();

    const detail = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/exercise-stats?exercise_id=${COMPETITION_DEADLIFT_ID}`)
      .set(auth(ctx.coachToken));
    const unbound = await request(ctx.app)
      .get(`/coach/students/${ids.otherStudent}/exercise-stats`)
      .set(auth(ctx.coachToken));
    const student = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/exercise-stats`)
      .set(auth(ctx.traineeToken));

    expect(detail.status).toBe(200);
    expect(detail.body.e1rm).toBeNull();
    expect(unbound.status).toBe(403);
    expect(unbound.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    expect(student.status).toBe(403);
    expect(student.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('keeps completed-plan logs in rep PRs and recent sessions', async () => {
    const ctx = await makeContext();
    await addExercise(ctx, COMPETITION_SQUAT_ID, '竞技深蹲', 'squat');
    const planExerciseIds = await addPlanExercise(ctx, COMPETITION_SQUAT_ID);
    const plan = await ctx.db
      .selectFrom('plans as p')
      .innerJoin('plan_days as pd', 'pd.plan_id', 'p.id')
      .innerJoin('plan_exercises as pe', 'pe.plan_day_id', 'pd.id')
      .select('p.id')
      .where('pe.id', '=', itemAt(planExerciseIds, 0))
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable('plans')
      .set({ status: 'completed' })
      .where('id', '=', plan.id)
      .execute();
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.trainee,
        plan_exercise_id: itemAt(planExerciseIds, 0),
        exercise_id: COMPETITION_SQUAT_ID,
        logged_date: daysFromToday(-2),
        set_index: 0,
        weight_kg: '105.00',
        reps: 5,
        completed: true,
        logged_at: atTenUtc(daysFromToday(-2)),
      })
      .execute();

    const response = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/exercise-stats?exercise_id=${COMPETITION_SQUAT_ID}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.rep_prs).toEqual([
      expect.objectContaining({ reps: 5, weight_kg: '105.00' }),
    ]);
    expect(response.body.recent_sessions).toEqual([
      expect.objectContaining({ date: daysFromToday(-2) }),
    ]);
  });

  it('counts completed-plan days in the recent four-week denominator', async () => {
    const ctx = await makeContext();
    await addExercise(ctx, COMPETITION_SQUAT_ID, '竞技深蹲', 'squat');
    const planExerciseIds = await addPlanExercise(ctx, COMPETITION_SQUAT_ID);
    const plan = await ctx.db
      .selectFrom('plans as p')
      .innerJoin('plan_days as pd', 'pd.plan_id', 'p.id')
      .innerJoin('plan_exercises as pe', 'pe.plan_day_id', 'pd.id')
      .select('p.id')
      .where('pe.id', '=', itemAt(planExerciseIds, 0))
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable('plans')
      .set({ status: 'completed' })
      .where('id', '=', plan.id)
      .execute();

    const response = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/exercise-stats`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.recent_4w).toEqual({
      trained_days: 0,
      total_planned_days: 6,
      completion_rate: 0,
    });
  });
});
