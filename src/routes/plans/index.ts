import { randomUUID } from 'node:crypto';

import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { sql } from 'kysely';

import { hasAcceptedBond } from '../../db/bonds';
import { planIdForDay, planIdForExercise, planIdForSet } from '../../db/planOwnership';
import type {
  Database,
  PlanDayShiftsTable,
  PlanDaysTable,
  PlanExercisesTable,
  PlansTable,
  PlanSetsTable,
  PlanStatus,
  UserRole,
} from '../../db/types';
import {
  effectiveDateBeforeBatch,
  effectivePlanDays,
  latestShiftByDay,
  latestShiftBatch,
  plannedDate as plannedDayDate,
} from '../../domain/plan-calendar';
import { hasActiveEvaluation } from '../../handlers/evaluations';
import type { Logger } from '../../logger';
import { requireRole } from '../../middleware/auth';
import { notifyPlanPublished } from '../../services/notifications';
import { calculateTrainingMaxKg, formatTrainingMaxKg } from '../../services/trainingMax';
import { uuidEquals } from '../../utils/uuid';
import { normalizeDateOnly, utcDate, utcDateOnly } from '../../utils/date';
import { visibleExerciseForCoach, visibleExercisesForCoach } from '../exercises';
import { route, validationEnvelope } from '../http';
import {
  ExerciseIdParamSchema,
  BatchDaysBodySchema,
  CreatePlanBodySchema,
  CreatePlanDayBodySchema,
  CreatePlanExerciseBodySchema,
  CreatePlanSetBodySchema,
  DayIdParamSchema,
  IdParamSchema,
  ImportedHistoryBodySchema,
  PatchPlanBodySchema,
  PatchPlanDayBodySchema,
  PatchPlanExerciseBodySchema,
  PatchPlanSetBodySchema,
  SetIdParamSchema,
  StudentPlansParamSchema,
  StudentPlansQuerySchema,
  WholePlanShiftBodySchema,
} from './schemas';
import {
  type PlanExerciseResponse,
  type PlanShiftSummaryResponse,
  type PlanSetResponse,
  type PlanWithChildrenResponse,
  toImportedHistory,
  toPlan,
  toPlanDay,
  toPlanExercise,
  toPlanShiftSummary,
  toPlanSet,
} from './serialization';

interface PlansRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
}

type DbExecutor = Kysely<Database> | Transaction<Database>;
type PlanRow = Selectable<PlansTable>;
type PlanDayRow = Selectable<PlanDaysTable>;
type PlanDayShiftRow = Selectable<PlanDayShiftsTable>;
type PlanSetRow = Selectable<PlanSetsTable>;
type PlanSetValidationShape = Pick<
  PlanSetRow,
  'target_reps' | 'target_reps_max' | 'intensity_mode' | 'target_value'
>;

interface PublishCounts {
  day_count: number;
  exercise_count: number;
  set_count: number;
  empty_day_count: number;
  empty_exercise_count: number;
}

interface ImportedHistorySetRow {
  plan_exercise_id: string;
  exercise_id: string;
  week_number: number;
  day_of_week: number;
  set_number: number;
  target_reps: number;
  intensity_mode: PlanSetRow['intensity_mode'];
  target_value: string;
}

interface ImportedHistoryCandidate {
  set: ImportedHistorySetRow;
  plannedDate: string;
}

function validationIssue(path: string[], message: string) {
  return { error: 'VALIDATION_ERROR', issues: [{ path, message }] };
}

interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

function ensureUser(req: { user?: AuthenticatedUser }): AuthenticatedUser | null {
  return req.user ?? null;
}

function isAllowedPlanStatusTransition(from: PlanStatus, to: PlanStatus): boolean {
  return (
    (from === 'published' && to === 'paused') ||
    (from === 'paused' && to === 'published') ||
    (from === 'published' && to === 'completed')
  );
}

async function selectOwnedPlan(
  db: DbExecutor,
  planId: string,
  coachId: string,
): Promise<PlanRow | undefined> {
  return db
    .selectFrom('plans')
    .selectAll()
    .where('id', '=', planId)
    .where('coach_id', '=', coachId)
    .executeTakeFirst();
}

export async function getPlanWithChildren(
  db: Kysely<Database>,
  plan: PlanRow,
): Promise<PlanWithChildrenResponse> {
  const dayRows = await db
    .selectFrom('plan_days')
    .selectAll()
    .where('plan_id', '=', plan.id)
    .orderBy('week_number', 'asc')
    .orderBy('day_of_week', 'asc')
    .orderBy('sort_order', 'asc')
    .execute();

  const dayIds = dayRows.map((day) => day.id);
  const exerciseRows =
    dayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_exercises')
          .selectAll()
          .where('plan_day_id', 'in', dayIds)
          .orderBy('sort_order', 'asc')
          .execute();

  const shiftRows =
    dayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_day_shifts')
          .selectAll()
          .where('plan_day_id', 'in', dayIds)
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .execute();

  const exerciseIds = exerciseRows.map((exercise) => exercise.id);
  const loggedExerciseIds = await planExercisesWithLogs(db, exerciseIds);
  const setRows =
    exerciseIds.length === 0
      ? []
      : await db
          .selectFrom('plan_sets')
          .selectAll()
          .where('plan_exercise_id', 'in', exerciseIds)
          .orderBy('set_number', 'asc')
          .execute();

  const setsByExercise = new Map<string, PlanSetResponse[]>();
  for (const set of setRows) {
    const sets = setsByExercise.get(set.plan_exercise_id) ?? [];
    sets.push(toPlanSet(set));
    setsByExercise.set(set.plan_exercise_id, sets);
  }

  const exercisesByDay = new Map<string, PlanExerciseResponse[]>();
  for (const exercise of exerciseRows) {
    const exercises = exercisesByDay.get(exercise.plan_day_id) ?? [];
    exercises.push(
      toPlanExercise(
        exercise,
        setsByExercise.get(exercise.id) ?? [],
        loggedExerciseIds.has(exercise.id),
      ),
    );
    exercisesByDay.set(exercise.plan_day_id, exercises);
  }

  const shiftsByDay = latestShiftByDay(shiftRows);

  return {
    ...toPlan(plan),
    ...toPlanShiftSummary(shiftRows),
    days: dayRows.map((day) =>
      toPlanDay(
        day,
        exercisesByDay.get(day.id) ?? [],
        shiftsByDay.get(day.id)?.shifted_to_date ?? null,
      ),
    ),
  };
}

async function planShiftSummaries(
  db: Kysely<Database>,
  planIds: string[],
): Promise<Map<string, PlanShiftSummaryResponse>> {
  if (planIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('plan_day_shifts as pds')
    .innerJoin('plan_days as pd', 'pd.id', 'pds.plan_day_id')
    .select(['pd.plan_id as plan_id', 'pds.batch_id as batch_id', 'pds.created_at as created_at'])
    .where('pd.plan_id', 'in', planIds)
    .execute();
  const rowsByPlan = new Map<string, { batch_id: string; created_at: Date }[]>();
  for (const row of rows) {
    const planRows = rowsByPlan.get(row.plan_id) ?? [];
    planRows.push({ batch_id: row.batch_id, created_at: row.created_at });
    rowsByPlan.set(row.plan_id, planRows);
  }

  return new Map(
    planIds.map((planId) => [planId, toPlanShiftSummary(rowsByPlan.get(planId) ?? [])]),
  );
}

async function publishCounts(db: DbExecutor, planId: string): Promise<PublishCounts> {
  const days = await db
    .selectFrom('plan_days')
    .select(['id'])
    .where('plan_id', '=', planId)
    .execute();
  const dayIds = days.map((day) => day.id);

  const exercises =
    dayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_exercises')
          .select(['id', 'plan_day_id'])
          .where('plan_day_id', 'in', dayIds)
          .execute();
  const exerciseIds = exercises.map((exercise) => exercise.id);

  const sets =
    exerciseIds.length === 0
      ? []
      : await db
          .selectFrom('plan_sets')
          .select(['id', 'plan_exercise_id'])
          .where('plan_exercise_id', 'in', exerciseIds)
          .execute();

  const daysWithExercises = new Set(exercises.map((exercise) => exercise.plan_day_id));
  const exercisesWithSets = new Set(sets.map((set) => set.plan_exercise_id));

  return {
    day_count: days.length,
    exercise_count: exercises.length,
    set_count: sets.length,
    empty_day_count: days.filter((day) => !daysWithExercises.has(day.id)).length,
    empty_exercise_count: exercises.filter((exercise) => !exercisesWithSets.has(exercise.id))
      .length,
  };
}

function isPublishIncomplete(counts: PublishCounts): boolean {
  return counts.day_count === 0 || counts.empty_day_count > 0 || counts.empty_exercise_count > 0;
}

function normalizeTargetValue(value: string): string {
  return Number(value).toFixed(2);
}

async function planDayHasLogs(db: DbExecutor, dayId: string): Promise<boolean> {
  return (await loggedExerciseIdsForDay(db, dayId)).length > 0;
}

async function planExercisesWithLogs(db: DbExecutor, exerciseIds: string[]): Promise<Set<string>> {
  if (exerciseIds.length === 0) return new Set();

  const rows = await db
    .selectFrom('set_logs')
    .select('plan_exercise_id')
    .where('plan_exercise_id', 'in', exerciseIds)
    .groupBy('plan_exercise_id')
    .orderBy('plan_exercise_id', 'asc')
    .execute();

  return new Set(
    rows.flatMap((row) => (row.plan_exercise_id === null ? [] : [row.plan_exercise_id])),
  );
}

async function planExerciseHasLogs(db: DbExecutor, exerciseId: string): Promise<boolean> {
  return (await planExercisesWithLogs(db, [exerciseId])).has(exerciseId);
}

async function loggedExerciseIdsForDay(db: DbExecutor, dayId: string): Promise<string[]> {
  const exercises = await db
    .selectFrom('plan_exercises')
    .select('id')
    .where('plan_day_id', '=', dayId)
    .orderBy('id', 'asc')
    .execute();
  return [
    ...(await planExercisesWithLogs(
      db,
      exercises.map((exercise) => exercise.id),
    )),
  ];
}

interface ShiftedDayResponse {
  day_id: string;
  shifted_to_date: string;
}

type PlanShiftError =
  | 'ALREADY_STARTED'
  | 'NO_ACTIVE_SHIFT'
  | 'NOT_PLAN_STUDENT'
  | 'PLAN_NOT_ACTIVE'
  | 'SHIFT_ONLY_TODAY'
  | 'UNDO_WINDOW_PASSED';

function addUtcDaysToDateOnly(value: string, days: number): string {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateOnly(date);
}

async function lockPlanShiftContext(
  db: Transaction<Database>,
  planId: string,
): Promise<{ plan: PlanRow; days: PlanDayRow[]; shifts: PlanDayShiftRow[] } | null> {
  const plan = await db
    .selectFrom('plans')
    .selectAll()
    .where('id', '=', planId)
    .forUpdate()
    .executeTakeFirst();
  if (!plan) return null;

  const days = await db
    .selectFrom('plan_days')
    .selectAll()
    .where('plan_id', '=', planId)
    .orderBy('week_number', 'asc')
    .orderBy('day_of_week', 'asc')
    .orderBy('sort_order', 'asc')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  const dayIds = days.map((day) => day.id);
  const shifts =
    dayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_day_shifts')
          .selectAll()
          .where('plan_day_id', 'in', dayIds)
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .execute();
  return { plan, days, shifts };
}

async function createWholePlanShift(
  db: Transaction<Database>,
  planId: string,
  studentId: string,
  anchorDate?: string,
): Promise<
  | {
      type: 'shifted';
      batchId: string;
      shiftedDays: ShiftedDayResponse[];
      totalOffsetDays: number;
    }
  | { type: 'error'; error: PlanShiftError }
> {
  const context = await lockPlanShiftContext(db, planId);
  if (context?.plan.coach_id == null || !uuidEquals(context.plan.trainee_id, studentId)) {
    return { type: 'error', error: 'NOT_PLAN_STUDENT' };
  }
  if (context.plan.status !== 'published') {
    return { type: 'error', error: 'PLAN_NOT_ACTIVE' };
  }

  // The anchor is the client's local "today" when provided (see
  // WholePlanShiftBodySchema); the server's UTC day otherwise.
  const today = anchorDate ?? utcDateOnly(new Date());
  const effectiveDays = effectivePlanDays(context.plan, context.days, context.shifts);
  const todayDay = effectiveDays.find((item) => item.effectiveDate === today);
  if (!todayDay) {
    return { type: 'error', error: 'SHIFT_ONLY_TODAY' };
  }
  if (await planDayHasLogs(db, todayDay.day.id)) {
    return { type: 'error', error: 'ALREADY_STARTED' };
  }

  const batchId = randomUUID();
  const shiftedDays = effectiveDays
    .filter((item) => item.effectiveDate >= today)
    .map((item) => ({
      day_id: item.day.id,
      shifted_to_date: addUtcDaysToDateOnly(item.effectiveDate, 1),
    }));
  await db
    .insertInto('plan_day_shifts')
    .values(
      shiftedDays.map((day) => ({
        plan_day_id: day.day_id,
        student_id: studentId,
        batch_id: batchId,
        shifted_to_date: day.shifted_to_date,
      })),
    )
    .execute();

  return {
    type: 'shifted',
    batchId,
    shiftedDays,
    totalOffsetDays: new Set(context.shifts.map((shift) => shift.batch_id)).size + 1,
  };
}

async function undoLatestWholePlanShift(
  db: Transaction<Database>,
  planId: string,
  studentId: string,
): Promise<{ type: 'deleted'; batchId: string } | { type: 'error'; error: PlanShiftError }> {
  const context = await lockPlanShiftContext(db, planId);
  if (context?.plan.coach_id == null || !uuidEquals(context.plan.trainee_id, studentId)) {
    return { type: 'error', error: 'NOT_PLAN_STUDENT' };
  }

  const batchRows = latestShiftBatch(context.shifts);
  const firstBatchRow = batchRows[0];
  if (!firstBatchRow) {
    return { type: 'error', error: 'NO_ACTIVE_SHIFT' };
  }
  const today = utcDateOnly(new Date());
  if (utcDateOnly(firstBatchRow.created_at) !== today) {
    return { type: 'error', error: 'UNDO_WINDOW_PASSED' };
  }

  const daysById = new Map(context.days.map((day) => [day.id, day]));
  for (const row of batchRows) {
    const day = daysById.get(row.plan_day_id);
    if (
      day &&
      effectiveDateBeforeBatch(context.plan, day, context.shifts, row.batch_id) === today &&
      (await planDayHasLogs(db, day.id))
    ) {
      return { type: 'error', error: 'ALREADY_STARTED' };
    }
  }

  await db
    .deleteFrom('plan_day_shifts')
    .where('batch_id', '=', firstBatchRow.batch_id)
    .where(
      'plan_day_id',
      'in',
      context.days.map((day) => day.id),
    )
    .execute();
  return { type: 'deleted', batchId: firstBatchRow.batch_id };
}

async function createImportedHistory(
  db: Kysely<Database>,
  plan: PlanRow,
): Promise<{ created: number; existing: number }> {
  const rows = await db
    .selectFrom('plan_days as pd')
    .innerJoin('plan_exercises as pe', 'pe.plan_day_id', 'pd.id')
    .innerJoin('plan_sets as ps', 'ps.plan_exercise_id', 'pe.id')
    .select([
      'pe.id as plan_exercise_id',
      'pe.exercise_id as exercise_id',
      'pd.week_number as week_number',
      'pd.day_of_week as day_of_week',
      'ps.set_number as set_number',
      'ps.target_reps as target_reps',
      'ps.intensity_mode as intensity_mode',
      'ps.target_value as target_value',
    ])
    .where('pd.plan_id', '=', plan.id)
    .orderBy('pd.week_number', 'asc')
    .orderBy('pd.day_of_week', 'asc')
    .orderBy('pe.sort_order', 'asc')
    .orderBy('ps.set_number', 'asc')
    .execute();

  const today = utcDateOnly(new Date());
  const setsByExercise = new Map<string, ImportedHistoryCandidate[]>();
  for (const row of rows) {
    const plannedDate = plannedDayDate(plan.start_date, row.week_number, row.day_of_week);
    if (plannedDate >= today) continue;
    const sets = setsByExercise.get(row.plan_exercise_id) ?? [];
    sets.push({ set: row, plannedDate });
    setsByExercise.set(row.plan_exercise_id, sets);
  }

  const values = [...setsByExercise.values()].flatMap((sets) =>
    sets.map(({ set, plannedDate }, setIndex) => ({
      student_id: plan.trainee_id,
      plan_exercise_id: set.plan_exercise_id,
      exercise_id: set.exercise_id,
      logged_date: plannedDate,
      set_index: setIndex,
      weight_kg: set.intensity_mode === 'rpe' ? '0.00' : normalizeTargetValue(set.target_value),
      reps: set.target_reps,
      rpe: set.intensity_mode === 'rpe' ? Number(set.target_value).toFixed(1) : null,
      completed: true,
      failed: false,
      assumed: true,
      logged_at: new Date(`${plannedDate}T12:00:00.000Z`),
    })),
  );

  if (values.length === 0) return { created: 0, existing: 0 };

  const existingRows = await db
    .selectFrom('set_logs')
    .select(['plan_exercise_id', 'set_index'])
    .where('student_id', '=', plan.trainee_id)
    .where('plan_exercise_id', 'in', [...setsByExercise.keys()])
    .execute();
  const existingKeys = new Set(
    existingRows.map((row) => `${String(row.plan_exercise_id)}:${String(row.set_index)}`),
  );
  const missingValues = values.filter(
    (value) => !existingKeys.has(`${value.plan_exercise_id}:${String(value.set_index)}`),
  );

  let created = 0;
  if (missingValues.length > 0) {
    const inserted = await db
      .insertInto('set_logs')
      .values(missingValues)
      .onConflict((oc) => oc.columns(['student_id', 'plan_exercise_id', 'set_index']).doNothing())
      .returning(['id'])
      .execute();
    created = inserted.length;
  }

  return { created, existing: values.length - created };
}

async function planHistoryLocked(
  db: DbExecutor,
  planId: string,
  lockedExerciseIds?: string[],
): Promise<boolean> {
  const exerciseIds =
    lockedExerciseIds ??
    (
      await db
        .selectFrom('plan_exercises as pe')
        .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
        .select('pe.id')
        .where('pd.plan_id', '=', planId)
        .orderBy('pe.id', 'asc')
        .execute()
    ).map((exercise) => exercise.id);
  return (await planExercisesWithLogs(db, exerciseIds)).size > 0;
}

async function lockPlanExercise(db: Transaction<Database>, exerciseId: string): Promise<boolean> {
  const exercise = await db
    .selectFrom('plan_exercises')
    .select('id')
    .where('id', '=', exerciseId)
    .forUpdate()
    .executeTakeFirst();
  return exercise !== undefined;
}

async function lockPlanDayTree(
  db: Transaction<Database>,
  dayId: string,
): Promise<{ day: PlanDayRow; exerciseIds: string[] } | null> {
  const day = await db
    .selectFrom('plan_days')
    .selectAll()
    .where('id', '=', dayId)
    .forUpdate()
    .executeTakeFirst();
  if (!day) return null;

  const exercises = await db
    .selectFrom('plan_exercises')
    .select('id')
    .where('plan_day_id', '=', dayId)
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  return { day, exerciseIds: exercises.map((exercise) => exercise.id) };
}

async function lockOwnedPlan(
  db: Transaction<Database>,
  planId: string,
  coachId: string,
): Promise<PlanRow | undefined> {
  return db
    .selectFrom('plans')
    .selectAll()
    .where('id', '=', planId)
    .where('coach_id', '=', coachId)
    .forUpdate()
    .executeTakeFirst();
}

async function lockOwnedPlanTree(
  db: Transaction<Database>,
  planId: string,
  coachId: string,
): Promise<{ plan: PlanRow; exerciseIds: string[] } | null> {
  const plan = await lockOwnedPlan(db, planId, coachId);
  if (!plan) return null;

  const days = await db
    .selectFrom('plan_days')
    .select('id')
    .where('plan_id', '=', planId)
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  const dayIds = days.map((day) => day.id);
  const exercises =
    dayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_exercises')
          .select('id')
          .where('plan_day_id', 'in', dayIds)
          .orderBy('id', 'asc')
          .forUpdate()
          .execute();
  return { plan, exerciseIds: exercises.map((exercise) => exercise.id) };
}

function exerciseHistoryImmutable(exerciseIds: string[]) {
  return {
    error: 'EXERCISE_HISTORY_IMMUTABLE',
    details: { exercise_ids: exerciseIds },
  };
}

function dayHistoryImmutable(dayId: string, exerciseIds: string[]) {
  return {
    error: 'DAY_HISTORY_IMMUTABLE',
    details: { day_id: dayId, exercise_ids: exerciseIds },
  };
}

function trainingMaxWrite(oneRmKg: number | undefined): Record<string, unknown> {
  if (oneRmKg === undefined) return {};
  return {
    training_max: formatTrainingMaxKg(calculateTrainingMaxKg(oneRmKg)),
    tm_set_at: sql<Date>`now()`,
  };
}

function mergedSetValidation(
  existing: PlanSetValidationShape,
  patch: Partial<PlanSetValidationShape>,
) {
  const merged = { ...existing, ...patch };
  if (merged.target_reps_max !== null && merged.target_reps_max < merged.target_reps) {
    return validationIssue(
      ['target_reps_max'],
      'target_reps_max must be greater than or equal to target_reps',
    );
  }

  const numericValue = Number(merged.target_value);
  if (merged.intensity_mode === 'rpe' && (numericValue < 1 || numericValue > 10)) {
    return validationIssue(['target_value'], 'RPE target_value must be between 1.0 and 10.0');
  }
  if (merged.intensity_mode === 'weight' && (numericValue <= 0 || numericValue >= 1000)) {
    return validationIssue(
      ['target_value'],
      'Weight target_value must be greater than 0 and less than 1000',
    );
  }

  return null;
}

export function plansRouter(deps: PlansRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = CreatePlanBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const trainee = await deps.db
        .selectFrom('users')
        .select(['id'])
        .where('id', '=', body.data.trainee_id)
        .where('role', 'in', ['coached_student', 'self_train_student'])
        .executeTakeFirst();

      if (!trainee) {
        res.status(400).json({ error: 'TRAINEE_NOT_FOUND' });
        return;
      }

      const plan = await deps.db
        .insertInto('plans')
        .values({
          coach_id: user.id,
          trainee_id: body.data.trainee_id,
          name: body.data.name,
          start_date: body.data.start_date,
          end_date: body.data.end_date,
          plan_weeks: body.data.plan_weeks,
          source: body.data.source,
          source_template_id: body.data.source_template_id ?? null,
          kind: body.data.kind ?? 'regular',
          ...trainingMaxWrite(body.data.one_rm_kg),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      deps.logger.info(
        {
          planId: plan.id,
          coachId: user.id,
          traineeId: plan.trainee_id,
          planWeeks: plan.plan_weeks,
          source: plan.source,
        },
        'plan_created',
      );

      res.status(201).json(toPlan(plan));
    }),
  );

  router.get(
    '/:id',
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      let plan: PlanRow | undefined;
      if (user.role === 'coach') {
        plan = await selectOwnedPlan(deps.db, params.data.id, user.id);
      } else {
        plan = await deps.db
          .selectFrom('plans')
          .selectAll()
          .where('id', '=', params.data.id)
          .where('trainee_id', '=', user.id)
          .where('status', '=', 'published')
          .executeTakeFirst();
      }

      if (!plan) {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }

      res.status(200).json(await getPlanWithChildren(deps.db, plan));
    }),
  );

  router.patch(
    '/:id',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      const body = PatchPlanBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const hasCalendarMetadataMutation =
        body.data.start_date !== undefined ||
        body.data.end_date !== undefined ||
        body.data.plan_weeks !== undefined ||
        body.data.source_template_id !== undefined;

      const result = await deps.db.transaction().execute(async (trx) => {
        const lockedTree = hasCalendarMetadataMutation
          ? await lockOwnedPlanTree(trx, params.data.id, user.id)
          : null;
        const existing = lockedTree?.plan ?? (await lockOwnedPlan(trx, params.data.id, user.id));
        if (!existing) return { type: 'not-found' } as const;

        if (body.data.status && !isAllowedPlanStatusTransition(existing.status, body.data.status)) {
          return { type: 'invalid-status' } as const;
        }

        if (
          hasCalendarMetadataMutation &&
          lockedTree &&
          (await planHistoryLocked(trx, existing.id, lockedTree.exerciseIds))
        ) {
          return { type: 'history-immutable' } as const;
        }

        const mergedStartDate = body.data.start_date ?? existing.start_date;
        const mergedEndDate = body.data.end_date ?? existing.end_date;
        if (mergedEndDate < mergedStartDate) return { type: 'invalid-date-order' } as const;

        if (body.data.source_template_id !== undefined) {
          if (existing.source === 'template' && body.data.source_template_id === null) {
            return { type: 'template-id-required' } as const;
          }
          if (existing.source !== 'template' && body.data.source_template_id !== null) {
            return { type: 'template-id-must-be-null' } as const;
          }
        }

        const patch: Record<string, unknown> = { updated_at: sql<Date>`now()` };
        if (body.data.name !== undefined) patch.name = body.data.name;
        if (body.data.start_date !== undefined) patch.start_date = body.data.start_date;
        if (body.data.end_date !== undefined) patch.end_date = body.data.end_date;
        if (body.data.plan_weeks !== undefined) patch.plan_weeks = body.data.plan_weeks;
        if (body.data.status !== undefined) patch.status = body.data.status;
        if (body.data.source_template_id !== undefined) {
          patch.source_template_id = body.data.source_template_id;
        }
        Object.assign(patch, trainingMaxWrite(body.data.one_rm_kg));

        const updated = await trx
          .updateTable('plans')
          .set(patch)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { type: 'updated', plan: updated } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }
      if (result.type === 'invalid-status') {
        res
          .status(400)
          .json(validationIssue(['status'], 'Invalid plan status transition for PATCH'));
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json({ error: 'PLAN_HISTORY_IMMUTABLE' });
        return;
      }
      if (result.type === 'invalid-date-order') {
        res
          .status(400)
          .json(validationIssue(['end_date'], 'end_date must be on or after start_date'));
        return;
      }
      if (result.type === 'template-id-required') {
        res
          .status(400)
          .json(validationIssue(['source_template_id'], 'source_template_id is required'));
        return;
      }
      if (result.type === 'template-id-must-be-null') {
        res
          .status(400)
          .json(validationIssue(['source_template_id'], 'source_template_id must be null'));
        return;
      }

      res.status(200).json(toPlan(result.plan));
    }),
  );

  router.delete(
    '/:id',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const plan = await selectOwnedPlan(trx, params.data.id, user.id);
        if (!plan) return { type: 'not-found' } as const;
        if (plan.status !== 'draft') {
          return { type: 'tree-immutable', status: plan.status } as const;
        }
        if (await planHistoryLocked(trx, plan.id)) {
          return { type: 'history-immutable' } as const;
        }

        await trx.deleteFrom('plans').where('id', '=', plan.id).execute();
        return { type: 'deleted' } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }
      if (result.type === 'tree-immutable') {
        res.status(409).json({ error: 'PLAN_TREE_IMMUTABLE', status: result.status });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json({ error: 'PLAN_HISTORY_IMMUTABLE' });
        return;
      }

      res.status(204).send();
    }),
  );

  router.post(
    '/:id/imported-history',
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      const body = ImportedHistoryBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const plan =
        user.role === 'coach'
          ? await selectOwnedPlan(deps.db, params.data.id, user.id)
          : await deps.db
              .selectFrom('plans')
              .selectAll()
              .where('id', '=', params.data.id)
              .where('trainee_id', '=', user.id)
              .executeTakeFirst();
      if (!plan) {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }

      if (user.role === 'coach' && !(await hasAcceptedBond(deps.db, user.id, plan.trainee_id))) {
        res.status(403).json({ error: 'BIND_NOT_ACCEPTED' });
        return;
      }

      const result = await deps.db
        .transaction()
        .execute(async (trx) => createImportedHistory(trx, plan));
      deps.logger.info(
        {
          planId: plan.id,
          studentId: plan.trainee_id,
          created: result.created,
          existing: result.existing,
        },
        'imported_history_confirmed',
      );
      res.status(200).json(toImportedHistory(plan.id, result.created, result.existing));
    }),
  );

  router.post(
    '/:id/publish',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const plan = await trx
          .selectFrom('plans')
          .selectAll()
          .where('id', '=', params.data.id)
          .executeTakeFirst();

        if (!plan || !uuidEquals(plan.coach_id, user.id)) {
          return { type: 'not-found' as const };
        }
        if (plan.status !== 'draft') {
          return { type: 'not-draft' as const };
        }

        if (!(await hasAcceptedBond(trx, user.id, plan.trainee_id))) {
          return { type: 'bind-not-accepted' as const, planId: plan.id };
        }

        // Evaluation hard gate (spec 005 D9): while the coach has an active
        // evaluation period with this trainee, only a 1-week adaptation plan
        // may be published. Server-side enforcement — not just hidden UI.
        const isAdaptationWeek = plan.kind === 'adaptation' && plan.plan_weeks === 1;
        if (!isAdaptationWeek) {
          const evaluating = await hasActiveEvaluation(trx, user.id, plan.trainee_id);
          if (evaluating) {
            return { type: 'evaluation-in-progress' as const, planId: plan.id };
          }
        }

        // Days must fit the declared horizon: a 1-week adaptation plan with
        // week-2+ days is a disguised full plan slipping past the evaluation
        // gate (Codex review P1).
        const overflowDay = await trx
          .selectFrom('plan_days')
          .select(['id'])
          .where('plan_id', '=', plan.id)
          .where('week_number', '>', plan.plan_weeks)
          .limit(1)
          .executeTakeFirst();
        if (overflowDay) {
          return { type: 'weeks-overflow' as const, planId: plan.id };
        }

        const counts = await publishCounts(trx, plan.id);
        if (isPublishIncomplete(counts)) {
          return { type: 'incomplete' as const, planId: plan.id, counts };
        }

        const updated = await trx
          .updateTable('plans')
          .set({ status: 'published', updated_at: sql<Date>`now()` })
          .where('id', '=', plan.id)
          .where('status', '=', 'draft')
          .returningAll()
          .executeTakeFirst();
        if (!updated) {
          return { type: 'not-draft' as const };
        }

        await trx
          .insertInto('notification_outbox')
          .values({
            event_type: 'plan_published',
            aggregate_id: plan.id,
            recipient_id: plan.trainee_id,
            payload: JSON.stringify({ plan_id: plan.id, trainee_id: plan.trainee_id }),
          })
          .onConflict((oc) =>
            oc.columns(['event_type', 'aggregate_id', 'recipient_id']).doNothing(),
          )
          .execute();

        return { type: 'published' as const, plan: updated, counts };
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }
      if (result.type === 'not-draft') {
        res.status(409).json({ error: 'PLAN_NOT_DRAFT' });
        return;
      }
      if (result.type === 'bind-not-accepted') {
        deps.logger.warn(
          { planId: result.planId, reason: 'bind_not_accepted' },
          'plan_publish_rejected',
        );
        res.status(403).json({ error: 'BIND_NOT_ACCEPTED' });
        return;
      }
      if (result.type === 'evaluation-in-progress') {
        deps.logger.warn(
          { planId: result.planId, reason: 'evaluation_in_progress' },
          'plan_publish_rejected',
        );
        res.status(403).json({ error: 'EVALUATION_IN_PROGRESS' });
        return;
      }
      if (result.type === 'weeks-overflow') {
        deps.logger.warn(
          { planId: result.planId, reason: 'days_exceed_plan_weeks' },
          'plan_publish_rejected',
        );
        res.status(422).json({ error: 'PLAN_DAYS_EXCEED_WEEKS' });
        return;
      }

      if (result.type === 'incomplete') {
        deps.logger.warn(
          {
            planId: result.planId,
            reason: 'incomplete_tree',
            empty_day_count: result.counts.empty_day_count,
            empty_exercise_count: result.counts.empty_exercise_count,
          },
          'plan_publish_rejected',
        );
        res.status(422).json({ error: 'PLAN_PUBLISH_INCOMPLETE', ...result.counts });
        return;
      }

      deps.logger.info(
        {
          planId: result.plan.id,
          dayCount: result.counts.day_count,
          exerciseCount: result.counts.exercise_count,
          setCount: result.counts.set_count,
        },
        'plan_published',
      );

      try {
        await notifyPlanPublished(result.plan.id, result.plan.trainee_id, deps.logger);
      } catch (error: unknown) {
        deps.logger.warn({ err: error, planId: result.plan.id }, 'plan_publish_notify_failed');
      }

      res.status(200).json(toPlan(result.plan));
    }),
  );

  router.post(
    '/:id/days/batch',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const plan = await selectOwnedPlan(deps.db, params.data.id, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }

      const body = BatchDaysBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const exerciseIds = [
        ...new Set(
          body.data.upsert_days.flatMap((day) =>
            day.exercises.map((exercise) => exercise.exercise_id),
          ),
        ),
      ];
      const visibleExerciseIds = await visibleExercisesForCoach(deps.db, exerciseIds, user.id);
      const missingExerciseIds = exerciseIds.filter(
        (exerciseId) => !visibleExerciseIds.has(exerciseId),
      );
      if (missingExerciseIds.length > 0) {
        res.status(400).json({
          error: 'EXERCISE_NOT_FOUND_OR_HIDDEN',
          details: { exercise_ids: missingExerciseIds },
        });
        return;
      }

      const hasCalendarMetadataMutation =
        body.data.plan_patch?.start_date !== undefined ||
        body.data.plan_patch?.end_date !== undefined ||
        body.data.plan_patch?.plan_weeks !== undefined;

      const result = await deps.db.transaction().execute(async (trx) => {
        let currentPlan = plan;

        if (hasCalendarMetadataMutation) {
          const lockedTree = await lockOwnedPlanTree(trx, plan.id, user.id);
          if (!lockedTree) return { type: 'not-found' } as const;
          currentPlan = lockedTree.plan;
          if (await planHistoryLocked(trx, plan.id, lockedTree.exerciseIds)) {
            return { type: 'plan-history-immutable' } as const;
          }
        }

        const ownedDeleteDays =
          body.data.delete_day_ids.length === 0
            ? []
            : await trx
                .selectFrom('plan_days')
                .select('id')
                .where('plan_id', '=', plan.id)
                .where('id', 'in', body.data.delete_day_ids)
                .orderBy('id', 'asc')
                .execute();
        const immutableDayIds: string[] = [];
        for (const deleteDay of ownedDeleteDays) {
          const lockedDay = await lockPlanDayTree(trx, deleteDay.id);
          if (lockedDay && (await planExercisesWithLogs(trx, lockedDay.exerciseIds)).size > 0) {
            immutableDayIds.push(deleteDay.id);
          }
        }
        if (immutableDayIds.length > 0) {
          return { type: 'day-history-immutable', dayIds: immutableDayIds } as const;
        }

        if (body.data.plan_patch) {
          const mergedStartDate = normalizeDateOnly(
            body.data.plan_patch.start_date ?? currentPlan.start_date,
          );
          const mergedEndDate = normalizeDateOnly(
            body.data.plan_patch.end_date ?? currentPlan.end_date,
          );
          if (mergedEndDate < mergedStartDate) {
            return { type: 'invalid-date-order' } as const;
          }

          const patch: Record<string, unknown> = { updated_at: sql<Date>`now()` };
          if (body.data.plan_patch.name !== undefined) patch.name = body.data.plan_patch.name;
          if (body.data.plan_patch.start_date !== undefined) {
            patch.start_date = body.data.plan_patch.start_date;
          }
          if (body.data.plan_patch.end_date !== undefined) {
            patch.end_date = body.data.plan_patch.end_date;
          }
          if (body.data.plan_patch.plan_weeks !== undefined) {
            patch.plan_weeks = body.data.plan_patch.plan_weeks;
          }
          currentPlan = await trx
            .updateTable('plans')
            .set(patch)
            .where('id', '=', plan.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        }

        const deletedDays =
          body.data.delete_day_ids.length === 0
            ? []
            : await trx
                .deleteFrom('plan_days')
                .where('plan_id', '=', plan.id)
                .where('id', 'in', body.data.delete_day_ids)
                .returning('id')
                .execute();

        let exercisesCreated = 0;
        let setsCreated = 0;
        for (const day of body.data.upsert_days) {
          const createdDay = await trx
            .insertInto('plan_days')
            .values({
              plan_id: plan.id,
              week_number: day.week_number,
              day_of_week: day.day_of_week,
              sort_order: day.sort_order,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          for (const exercise of day.exercises) {
            const createdExercise = await trx
              .insertInto('plan_exercises')
              .values({
                plan_day_id: createdDay.id,
                exercise_id: exercise.exercise_id,
                is_main_lift: exercise.is_main_lift,
                sort_order: exercise.sort_order,
                notes: exercise.notes ?? null,
              })
              .returning('id')
              .executeTakeFirstOrThrow();
            exercisesCreated += 1;

            if (exercise.sets.length > 0) {
              await trx
                .insertInto('plan_sets')
                .values(
                  exercise.sets.map((set) => ({
                    plan_exercise_id: createdExercise.id,
                    set_number: set.set_number,
                    target_reps: set.target_reps,
                    target_reps_max: set.target_reps_max ?? null,
                    intensity_mode: set.intensity_mode,
                    target_value: normalizeTargetValue(set.target_value),
                    set_type: set.set_type,
                    rest_seconds: set.rest_seconds ?? null,
                    coach_note: set.coach_note ?? null,
                  })),
                )
                .execute();
              setsCreated += exercise.sets.length;
            }
          }
        }

        return {
          type: 'batched',
          plan: currentPlan,
          daysDeleted: deletedDays.length,
          daysUpserted: body.data.upsert_days.length,
          exercisesCreated,
          setsCreated,
        } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }
      if (result.type === 'plan-history-immutable') {
        res.status(409).json({ error: 'PLAN_HISTORY_IMMUTABLE' });
        return;
      }
      if (result.type === 'day-history-immutable') {
        res.status(409).json({
          error: 'DAY_HISTORY_IMMUTABLE',
          details: { day_ids: result.dayIds },
        });
        return;
      }
      if (result.type === 'invalid-date-order') {
        res
          .status(400)
          .json(validationIssue(['end_date'], 'end_date must be on or after start_date'));
        return;
      }

      deps.logger.info(
        {
          planId: plan.id,
          daysDeleted: result.daysDeleted,
          daysUpserted: result.daysUpserted,
          exercisesCreated: result.exercisesCreated,
          setsCreated: result.setsCreated,
        },
        'plan_days_batched',
      );
      res.status(200).json(await getPlanWithChildren(deps.db, result.plan));
    }),
  );

  router.post(
    '/:id/days',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      const body = CreatePlanDayBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const plan = await selectOwnedPlan(deps.db, params.data.id, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }

      const day = await deps.db
        .insertInto('plan_days')
        .values({ plan_id: plan.id, ...body.data })
        .returningAll()
        .executeTakeFirstOrThrow();

      deps.logger.info(
        { planId: plan.id, action: 'day', op: 'create', resourceId: day.id },
        'plan_tree_mutated',
      );
      res.status(201).json(toPlanDay(day));
    }),
  );

  router.patch(
    '/days/:dayId',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = DayIdParamSchema.safeParse(req.params);
      const body = PatchPlanDayBodySchema.safeParse(req.body);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const planId = await planIdForDay(trx, params.data.dayId, user.id);
        if (!planId) return { type: 'not-found' } as const;

        const locked = await lockPlanDayTree(trx, params.data.dayId);
        if (!locked) return { type: 'not-found' } as const;
        const loggedExerciseIds = [...(await planExercisesWithLogs(trx, locked.exerciseIds))];
        if (loggedExerciseIds.length > 0) {
          return { type: 'history-immutable', exerciseIds: loggedExerciseIds } as const;
        }

        const day = await trx
          .updateTable('plan_days')
          .set(body.data)
          .where('id', '=', params.data.dayId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { type: 'updated', planId, day } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json(dayHistoryImmutable(params.data.dayId, result.exerciseIds));
        return;
      }

      deps.logger.info(
        { planId: result.planId, action: 'day', op: 'update', resourceId: result.day.id },
        'plan_tree_mutated',
      );
      res.status(200).json(toPlanDay(result.day));
    }),
  );

  router.delete(
    '/days/:dayId',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = DayIdParamSchema.safeParse(req.params);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const planId = await planIdForDay(trx, params.data.dayId, user.id);
        if (!planId) return { type: 'not-found' } as const;

        const locked = await lockPlanDayTree(trx, params.data.dayId);
        if (!locked) return { type: 'not-found' } as const;
        const loggedExerciseIds = [...(await planExercisesWithLogs(trx, locked.exerciseIds))];
        if (loggedExerciseIds.length > 0) {
          return { type: 'history-immutable', exerciseIds: loggedExerciseIds } as const;
        }

        await trx.deleteFrom('plan_days').where('id', '=', params.data.dayId).execute();
        return { type: 'deleted', planId } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json(dayHistoryImmutable(params.data.dayId, result.exerciseIds));
        return;
      }

      deps.logger.info(
        { planId: result.planId, action: 'day', op: 'delete', resourceId: params.data.dayId },
        'plan_tree_mutated',
      );
      res.status(204).send();
    }),
  );

  router.post(
    '/:id/shift',
    requireRole('coached_student'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = IdParamSchema.safeParse(req.params);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const body = WholePlanShiftBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await deps.db
        .transaction()
        .execute((trx) =>
          createWholePlanShift(trx, params.data.id, user.id, body.data.target_date),
        );
      if (result.type === 'error') {
        res.status(result.error === 'NOT_PLAN_STUDENT' ? 403 : 409).json({ error: result.error });
        return;
      }

      deps.logger.info(
        {
          planId: params.data.id,
          studentId: user.id,
          batchId: result.batchId,
          shiftedDayCount: result.shiftedDays.length,
          totalOffsetDays: result.totalOffsetDays,
        },
        'whole_plan_shifted',
      );
      res.status(201).json({
        batch_id: result.batchId,
        shifted_days: result.shiftedDays,
        total_offset_days: result.totalOffsetDays,
      });
    }),
  );

  router.delete(
    '/:id/shift',
    requireRole('coached_student'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = IdParamSchema.safeParse(req.params);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await deps.db
        .transaction()
        .execute((trx) => undoLatestWholePlanShift(trx, params.data.id, user.id));
      if (result.type === 'error') {
        res.status(result.error === 'NOT_PLAN_STUDENT' ? 403 : 409).json({ error: result.error });
        return;
      }

      deps.logger.info(
        { planId: params.data.id, studentId: user.id, batchId: result.batchId },
        'whole_plan_shift_deleted',
      );
      res.status(204).send();
    }),
  );

  router.post(
    '/days/:dayId/exercises',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = DayIdParamSchema.safeParse(req.params);
      const body = CreatePlanExerciseBodySchema.safeParse(req.body);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const planId = await planIdForDay(deps.db, params.data.dayId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }

      const exerciseVisible = await visibleExerciseForCoach(
        deps.db,
        body.data.exercise_id,
        user.id,
      );
      if (!exerciseVisible) {
        res.status(400).json({ error: 'EXERCISE_NOT_FOUND_OR_HIDDEN' });
        return;
      }

      const planExercise = await deps.db
        .insertInto('plan_exercises')
        .values({
          plan_day_id: params.data.dayId,
          exercise_id: body.data.exercise_id,
          is_main_lift: body.data.is_main_lift,
          sort_order: body.data.sort_order,
          notes: body.data.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      deps.logger.info(
        { planId, action: 'exercise', op: 'create', resourceId: planExercise.id },
        'plan_tree_mutated',
      );
      res.status(201).json(toPlanExercise(planExercise));
    }),
  );

  router.patch(
    '/exercises/:exerciseId',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = ExerciseIdParamSchema.safeParse(req.params);
      const body = PatchPlanExerciseBodySchema.safeParse(req.body);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const planId = await planIdForExercise(trx, params.data.exerciseId, user.id);
        if (!planId) return { type: 'not-found' } as const;
        if (!(await lockPlanExercise(trx, params.data.exerciseId))) {
          return { type: 'not-found' } as const;
        }
        if (await planExerciseHasLogs(trx, params.data.exerciseId)) {
          return { type: 'history-immutable' } as const;
        }
        if (body.data.exercise_id) {
          const exerciseVisible = await visibleExerciseForCoach(
            trx,
            body.data.exercise_id,
            user.id,
          );
          if (!exerciseVisible) return { type: 'exercise-hidden' } as const;
        }

        const patch: Updateable<PlanExercisesTable> = {};
        if (body.data.exercise_id !== undefined) patch.exercise_id = body.data.exercise_id;
        if (body.data.is_main_lift !== undefined) patch.is_main_lift = body.data.is_main_lift;
        if (body.data.sort_order !== undefined) patch.sort_order = body.data.sort_order;
        if (body.data.notes !== undefined) patch.notes = body.data.notes;

        const planExercise = await trx
          .updateTable('plan_exercises')
          .set(patch)
          .where('id', '=', params.data.exerciseId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { type: 'updated', planId, planExercise } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json(exerciseHistoryImmutable([params.data.exerciseId]));
        return;
      }
      if (result.type === 'exercise-hidden') {
        res.status(400).json({ error: 'EXERCISE_NOT_FOUND_OR_HIDDEN' });
        return;
      }

      deps.logger.info(
        {
          planId: result.planId,
          action: 'exercise',
          op: 'update',
          resourceId: result.planExercise.id,
        },
        'plan_tree_mutated',
      );
      res.status(200).json(toPlanExercise(result.planExercise));
    }),
  );

  router.delete(
    '/exercises/:exerciseId',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = ExerciseIdParamSchema.safeParse(req.params);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const planId = await planIdForExercise(trx, params.data.exerciseId, user.id);
        if (!planId) return { type: 'not-found' } as const;
        if (!(await lockPlanExercise(trx, params.data.exerciseId))) {
          return { type: 'not-found' } as const;
        }
        if (await planExerciseHasLogs(trx, params.data.exerciseId)) {
          return { type: 'history-immutable' } as const;
        }

        await trx.deleteFrom('plan_exercises').where('id', '=', params.data.exerciseId).execute();
        return { type: 'deleted', planId } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json(exerciseHistoryImmutable([params.data.exerciseId]));
        return;
      }

      deps.logger.info(
        {
          planId: result.planId,
          action: 'exercise',
          op: 'delete',
          resourceId: params.data.exerciseId,
        },
        'plan_tree_mutated',
      );
      res.status(204).send();
    }),
  );

  router.post(
    '/exercises/:exerciseId/sets',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = ExerciseIdParamSchema.safeParse(req.params);
      const body = CreatePlanSetBodySchema.safeParse(req.body);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const planId = await planIdForExercise(trx, params.data.exerciseId, user.id);
        if (!planId) return { type: 'not-found' } as const;
        if (!(await lockPlanExercise(trx, params.data.exerciseId))) {
          return { type: 'not-found' } as const;
        }
        if (await planExerciseHasLogs(trx, params.data.exerciseId)) {
          return { type: 'history-immutable' } as const;
        }

        const set = await trx
          .insertInto('plan_sets')
          .values({
            plan_exercise_id: params.data.exerciseId,
            set_number: body.data.set_number,
            target_reps: body.data.target_reps,
            target_reps_max: body.data.target_reps_max ?? null,
            intensity_mode: body.data.intensity_mode,
            target_value: normalizeTargetValue(body.data.target_value),
            set_type: body.data.set_type,
            rest_seconds: body.data.rest_seconds ?? null,
            coach_note: body.data.coach_note ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { type: 'created', planId, set } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json(exerciseHistoryImmutable([params.data.exerciseId]));
        return;
      }

      deps.logger.info(
        { planId: result.planId, action: 'set', op: 'create', resourceId: result.set.id },
        'plan_tree_mutated',
      );
      res.status(201).json(toPlanSet(result.set));
    }),
  );

  router.patch(
    '/sets/:setId',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = SetIdParamSchema.safeParse(req.params);
      const body = PatchPlanSetBodySchema.safeParse(req.body);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const planId = await planIdForSet(trx, params.data.setId, user.id);
        if (!planId) return { type: 'not-found' } as const;

        const existing = await trx
          .selectFrom('plan_sets')
          .selectAll()
          .where('id', '=', params.data.setId)
          .executeTakeFirst();
        if (!existing) return { type: 'not-found' } as const;
        if (!(await lockPlanExercise(trx, existing.plan_exercise_id))) {
          return { type: 'not-found' } as const;
        }
        if (await planExerciseHasLogs(trx, existing.plan_exercise_id)) {
          return {
            type: 'history-immutable',
            exerciseId: existing.plan_exercise_id,
          } as const;
        }

        const patch: Updateable<PlanSetsTable> = {};
        if (body.data.set_number !== undefined) patch.set_number = body.data.set_number;
        if (body.data.target_reps !== undefined) patch.target_reps = body.data.target_reps;
        if (body.data.target_reps_max !== undefined) {
          patch.target_reps_max = body.data.target_reps_max;
        }
        if (body.data.intensity_mode !== undefined) {
          patch.intensity_mode = body.data.intensity_mode;
        }
        if (body.data.target_value !== undefined) {
          patch.target_value = normalizeTargetValue(body.data.target_value);
        }
        if (body.data.set_type !== undefined) patch.set_type = body.data.set_type;
        if (body.data.rest_seconds !== undefined) patch.rest_seconds = body.data.rest_seconds;
        if (body.data.coach_note !== undefined) patch.coach_note = body.data.coach_note;

        const validation = mergedSetValidation(existing, patch);
        if (validation) return { type: 'validation', validation } as const;

        const set = await trx
          .updateTable('plan_sets')
          .set(patch)
          .where('id', '=', params.data.setId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { type: 'updated', planId, set } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_SET_NOT_FOUND' });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json(exerciseHistoryImmutable([result.exerciseId]));
        return;
      }
      if (result.type === 'validation') {
        res.status(400).json(result.validation);
        return;
      }

      deps.logger.info(
        { planId: result.planId, action: 'set', op: 'update', resourceId: result.set.id },
        'plan_tree_mutated',
      );
      res.status(200).json(toPlanSet(result.set));
    }),
  );

  router.delete(
    '/sets/:setId',
    requireRole('coach'),
    route(async (req, res) => {
      const user = ensureUser(req);
      const params = SetIdParamSchema.safeParse(req.params);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await deps.db.transaction().execute(async (trx) => {
        const planId = await planIdForSet(trx, params.data.setId, user.id);
        if (!planId) return { type: 'not-found' } as const;

        const set = await trx
          .selectFrom('plan_sets')
          .select('plan_exercise_id')
          .where('id', '=', params.data.setId)
          .executeTakeFirst();
        if (!set) return { type: 'not-found' } as const;
        if (!(await lockPlanExercise(trx, set.plan_exercise_id))) {
          return { type: 'not-found' } as const;
        }
        if (await planExerciseHasLogs(trx, set.plan_exercise_id)) {
          return { type: 'history-immutable', exerciseId: set.plan_exercise_id } as const;
        }

        await trx.deleteFrom('plan_sets').where('id', '=', params.data.setId).execute();
        return { type: 'deleted', planId } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'PLAN_SET_NOT_FOUND' });
        return;
      }
      if (result.type === 'history-immutable') {
        res.status(409).json(exerciseHistoryImmutable([result.exerciseId]));
        return;
      }

      deps.logger.info(
        { planId: result.planId, action: 'set', op: 'delete', resourceId: params.data.setId },
        'plan_tree_mutated',
      );
      res.status(204).send();
    }),
  );

  return router;
}

export function studentPlansRouter(deps: PlansRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/:studentId/plans',
    route(async (req, res) => {
      const user = ensureUser(req);
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = StudentPlansParamSchema.safeParse(req.params);
      const query = StudentPlansQuerySchema.safeParse(req.query);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      let dbQuery = deps.db
        .selectFrom('plans')
        .selectAll()
        .where('trainee_id', '=', params.data.studentId)
        .orderBy('created_at', 'desc');

      if (user.role === 'coach') {
        dbQuery = dbQuery.where('coach_id', '=', user.id);
        if (query.data.status && query.data.status.length > 0) {
          dbQuery = dbQuery.where('status', 'in', query.data.status);
        }
      } else {
        if (!uuidEquals(params.data.studentId, user.id)) {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
        dbQuery = dbQuery.where('status', '=', 'published');
      }

      const plans = await dbQuery.execute();
      const shiftSummaries = await planShiftSummaries(
        deps.db,
        plans.map((plan) => plan.id),
      );
      res.status(200).json({
        plans: plans.map((plan) => ({
          ...toPlan(plan),
          ...(shiftSummaries.get(plan.id) ?? toPlanShiftSummary([])),
        })),
      });
    }),
  );

  return router;
}
