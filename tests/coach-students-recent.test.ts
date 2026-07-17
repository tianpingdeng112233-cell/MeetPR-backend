import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { listCoachStudents } from '../src/handlers/coach-students';
import { fetchExerciseStatsOverview } from '../src/handlers/exercise-stats';
import { ids, makeContext, type TestContext } from './helpers/studentActions';

const now = new Date('2026-07-15T12:00:00.000Z');

async function acceptOtherStudent(ctx: TestContext): Promise<void> {
  await ctx.db
    .insertInto('bind_requests')
    .values({
      student_id: ids.otherStudent,
      coach_id: ids.coach,
      status: 'accepted',
      expired_at: new Date('2026-07-31T00:00:00.000Z'),
    })
    .execute();
}

async function addCalendar(
  ctx: TestContext,
  studentId: string,
  days: { week_number: number; day_of_week: number }[],
) {
  const plan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: ids.coach,
      trainee_id: studentId,
      name: 'Roster recent weeks',
      start_date: '2026-06-15',
      end_date: '2026-07-19',
      plan_weeks: 5,
      source: 'coach',
      status: 'published',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const planDays = await ctx.db
    .insertInto('plan_days')
    .values(days.map((day) => ({ plan_id: plan.id, ...day })))
    .returning('id')
    .execute();
  const exercises = await ctx.db
    .insertInto('plan_exercises')
    .values(
      planDays.map((day) => ({
        plan_day_id: day.id,
        exercise_id: ids.exercise,
        is_main_lift: true,
      })),
    )
    .returning(['id', 'plan_day_id'])
    .execute();
  return { planDays, exercises };
}

async function addCompletedLog(
  ctx: TestContext,
  studentId: string,
  planExerciseId: string,
  loggedDate: string,
  assumed = false,
  setIndex = 0,
  failed = false,
): Promise<void> {
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: studentId,
      plan_exercise_id: planExerciseId,
      exercise_id: ids.exercise,
      set_index: setIndex,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
      failed,
      assumed,
      logged_date: loggedDate,
      logged_at: new Date(`${loggedDate}T10:00:00.000Z`),
    })
    .execute();
}

describe('coach roster recent fields', () => {
  it('does not count a failed-only day as trained (0017: failed can be completed)', async () => {
    const ctx = await makeContext();
    // Plan starts 2026-06-15 (Monday); week 4 day 3 = 2026-07-08, inside the
    // newest complete week for `now` (2026-07-15).
    const { exercises } = await addCalendar(ctx, ids.trainee, [{ week_number: 4, day_of_week: 3 }]);
    const exerciseId = exercises[0]?.id;
    if (exerciseId === undefined) throw new Error('fixture exercise missing');
    await addCompletedLog(ctx, ids.trainee, exerciseId, '2026-07-08', false, 0, true);

    const roster = await listCoachStudents(ctx.db, ids.coach, now);
    const trainee = roster.find((student) => student.id === ids.trainee);
    expect(trainee?.recent_4w.every((week) => week.trained_days === 0)).toBe(true);
  });

  it('normalizes competition_date and keeps a missing onboarding row null', async () => {
    const ctx = await makeContext();
    await acceptOtherStudent(ctx);
    await ctx.db
      .insertInto('student_onboarding_profiles')
      .values({ user_id: ids.trainee, competition_date: '2026-11-08' })
      .execute();

    const roster = await listCoachStudents(ctx.db, ids.coach, now);
    const byId = new Map(roster.map((student) => [student.id, student]));

    expect(byId.get(ids.trainee)?.competition_date).toBe('2026-11-08');
    expect(byId.get(ids.otherStudent)?.competition_date).toBeNull();
    expect(byId.get(ids.otherStudent)?.recent_4w).toEqual([
      { trained_days: 0, planned_days: 0 },
      { trained_days: 0, planned_days: 0 },
      { trained_days: 0, planned_days: 0 },
      { trained_days: 0, planned_days: 0 },
    ]);
  });

  it('uses four complete Monday weeks, latest shifted dates, and one batch per table family', async () => {
    const queries: string[] = [];
    const ctx = await makeContext(undefined, {
      afterQuery: (query) => {
        queries.push(query);
        return Promise.resolve();
      },
    });
    await acceptOtherStudent(ctx);
    const trainee = await addCalendar(ctx, ids.trainee, [
      { week_number: 1, day_of_week: 1 }, // 06-15
      { week_number: 2, day_of_week: 2 }, // 06-23
      { week_number: 3, day_of_week: 3 }, // 07-01 -> shifted to 07-06
      { week_number: 4, day_of_week: 4 }, // 07-09
      { week_number: 5, day_of_week: 1 }, // 07-13, current week excluded
    ]);
    const other = await addCalendar(ctx, ids.otherStudent, [
      { week_number: 2, day_of_week: 1 }, // 06-22
    ]);
    const shiftedDay = trainee.planDays[2];
    if (shiftedDay === undefined) throw new Error('Missing shifted plan day fixture');
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        plan_day_id: shiftedDay.id,
        student_id: ids.trainee,
        batch_id: randomUUID(),
        shifted_to_date: '2026-07-06',
      })
      .execute();

    const traineeExerciseIds = trainee.exercises.map((exercise) => exercise.id);
    const firstExercise = traineeExerciseIds[0];
    const secondExercise = traineeExerciseIds[1];
    const thirdExercise = traineeExerciseIds[2];
    const fourthExercise = traineeExerciseIds[3];
    const fifthExercise = traineeExerciseIds[4];
    const otherExercise = other.exercises[0];
    if (
      firstExercise === undefined ||
      secondExercise === undefined ||
      thirdExercise === undefined ||
      fourthExercise === undefined ||
      fifthExercise === undefined ||
      otherExercise === undefined
    ) {
      throw new Error('Missing plan exercise fixture');
    }
    await addCompletedLog(ctx, ids.trainee, firstExercise, '2026-06-15');
    await addCompletedLog(ctx, ids.trainee, secondExercise, '2026-06-28');
    await addCompletedLog(ctx, ids.trainee, thirdExercise, '2026-07-05');
    await addCompletedLog(ctx, ids.trainee, fourthExercise, '2026-07-06');
    await addCompletedLog(ctx, ids.trainee, fifthExercise, '2026-07-13');
    await addCompletedLog(ctx, ids.trainee, firstExercise, '2026-06-20', true, 1);
    await addCompletedLog(ctx, ids.otherStudent, otherExercise.id, '2026-06-22');

    queries.length = 0;
    const roster = await listCoachStudents(ctx.db, ids.coach, now);
    const byId = new Map(roster.map((student) => [student.id, student]));

    expect(byId.get(ids.trainee)?.recent_4w).toEqual([
      { trained_days: 1, planned_days: 1 },
      { trained_days: 1, planned_days: 1 },
      { trained_days: 1, planned_days: 0 },
      { trained_days: 1, planned_days: 2 },
    ]);
    expect(byId.get(ids.otherStudent)?.recent_4w).toEqual([
      { trained_days: 0, planned_days: 0 },
      { trained_days: 1, planned_days: 1 },
      { trained_days: 0, planned_days: 0 },
      { trained_days: 0, planned_days: 0 },
    ]);
    expect(queries.filter((query) => /^\s*select\b/i.test(query))).toHaveLength(4);

    const overview = await fetchExerciseStatsOverview(ctx.db, ids.coach, ids.trainee, now);
    expect(overview.recent_4w).toEqual({
      trained_days: 4,
      total_planned_days: 4,
      completion_rate: 1,
    });
  });
});
