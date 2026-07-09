import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { sql } from 'kysely';

import { planIdForDay, planIdForExercise, planIdForSet } from '../../db/planOwnership';
import { hasAcceptedBond } from '../../db/bonds';
import type {
  Database,
  PlanExercisesTable,
  PlansTable,
  PlanSetsTable,
  PlanStatus,
  UserRole,
} from '../../db/types';
import { hasActiveEvaluation } from '../../handlers/evaluations';
import type { Logger } from '../../logger';
import { requireRole } from '../../middleware/auth';
import { notifyPlanPublished } from '../../services/notifications';
import { uuidEquals } from '../../utils/uuid';
import { utcDate, utcDateOnly } from '../../utils/date';
import { visibleExerciseForCoach } from '../exercises';
import { route, validationEnvelope } from '../http';
import {
  ExerciseIdParamSchema,
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
} from './schemas';
import {
  type PlanExerciseResponse,
  type PlanSetResponse,
  type PlanWithChildrenResponse,
  toPlan,
  toPlanDay,
  toPlanExercise,
  toPlanSet,
} from './serialization';

interface PlansRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
}

type DbExecutor = Kysely<Database> | Transaction<Database>;
type PlanRow = Selectable<PlansTable>;
type PlanSetRow = Selectable<PlanSetsTable>;

interface PublishCounts {
  day_count: number;
  exercise_count: number;
  set_count: number;
  empty_day_count: number;
  empty_exercise_count: number;
}

interface ImportedHistorySetRow {
  plan_exercise_id: string;
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

async function getPlanWithChildren(
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

  const exerciseIds = exerciseRows.map((exercise) => exercise.id);
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
    exercises.push(toPlanExercise(exercise, setsByExercise.get(exercise.id) ?? []));
    exercisesByDay.set(exercise.plan_day_id, exercises);
  }

  return {
    ...toPlan(plan),
    days: dayRows.map((day) => toPlanDay(day, exercisesByDay.get(day.id) ?? [])),
  };
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

function isMutablePlanTree(plan: PlanRow): boolean {
  return plan.status === 'draft';
}

type PlanTreeMutationError =
  | { error: 'PLAN_TREE_IMMUTABLE'; status: PlanStatus }
  | { error: 'PLAN_HISTORY_IMMUTABLE' };

async function planTreeMutationError(
  db: DbExecutor,
  plan: PlanRow,
): Promise<PlanTreeMutationError | null> {
  if (!isMutablePlanTree(plan)) {
    return { error: 'PLAN_TREE_IMMUTABLE', status: plan.status };
  }

  // An explicit historical import may happen while a Plan Web draft is still
  // open. Once set logs exist, lock the entire tree as well as published trees:
  // changing exercise identity or set ordering would reinterpret history.
  const loggedSet = await db
    .selectFrom('set_logs as sl')
    .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .select(['sl.id'])
    .where('pd.plan_id', '=', plan.id)
    .limit(1)
    .executeTakeFirst();
  return loggedSet ? { error: 'PLAN_HISTORY_IMMUTABLE' } : null;
}

function normalizeTargetValue(value: string): string {
  return Number(value).toFixed(2);
}

function plannedDayDate(startDate: string, weekNumber: number, dayOfWeek: number): string {
  const start = utcDate(startDate);
  // API weekday values use ISO-8601 (Monday=1); align week one to the actual
  // weekday of start_date rather than relying on a server-local Date parser.
  const startDayOfWeek = ((start.getUTCDay() + 6) % 7) + 1;
  const dayOffset = (dayOfWeek - startDayOfWeek + 7) % 7;
  start.setUTCDate(start.getUTCDate() + (weekNumber - 1) * 7 + dayOffset);
  return utcDateOnly(start);
}

async function createImportedHistory(
  db: Kysely<Database>,
  plan: PlanRow,
): Promise<{ created: number; existing: number }> {
  const rows = (await db
    .selectFrom('plan_days as pd')
    .innerJoin('plan_exercises as pe', 'pe.plan_day_id', 'pd.id')
    .innerJoin('plan_sets as ps', 'ps.plan_exercise_id', 'pe.id')
    .select([
      'pe.id as plan_exercise_id',
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
    .execute()) as ImportedHistorySetRow[];

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
      // The existing student API uses a zero-based set_index; it maps to the
      // ordered plan-set position, not a client-supplied set_number.
      set_index: setIndex,
      weight_kg: set.intensity_mode === 'rpe' ? '0.00' : normalizeTargetValue(set.target_value),
      reps: set.target_reps,
      rpe: set.intensity_mode === 'rpe' ? Number(set.target_value).toFixed(1) : null,
      completed: true,
      failed: false,
      assumed: true,
      // Retain the original planned date in activity/history queries instead
      // of incorrectly making a 2024 import look like today's workout.
      logged_at: new Date(`${plannedDate}T12:00:00.000Z`),
    })),
  );

  if (values.length === 0) return { created: 0, existing: 0 };

  const exerciseIds = [...setsByExercise.keys()];
  const existingRows = await db
    .selectFrom('set_logs')
    .select(['plan_exercise_id', 'set_index'])
    .where('student_id', '=', plan.trainee_id)
    .where('plan_exercise_id', 'in', exerciseIds)
    .execute();
  const existingKeys = new Set(
    existingRows.map((row) => `${row.plan_exercise_id}:${String(row.set_index)}`),
  );
  const missingValues = values.filter(
    (value) => !existingKeys.has(`${value.plan_exercise_id}:${String(value.set_index)}`),
  );

  let created = 0;
  if (missingValues.length > 0) {
    const inserted = await db
      .insertInto('set_logs')
      .values(missingValues)
      // The unique constraint is the concurrency backstop. Returning only rows
      // actually inserted keeps the response count honest if another request
      // confirms the same history between the read above and this insert.
      .onConflict((oc) => oc.columns(['student_id', 'plan_exercise_id', 'set_index']).doNothing())
      .returning(['id'])
      .execute();
    created = inserted.length;
  }

  return { created, existing: values.length - created };
}

function mergedSetValidation(existing: PlanSetRow, patch: Partial<PlanSetRow>) {
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

      if (!(await hasAcceptedBond(deps.db, user.id, body.data.trainee_id))) {
        res.status(403).json({ error: 'BIND_NOT_ACCEPTED' });
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
          .where('status', 'in', ['published', 'completed', 'paused'])
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

      const existing = await selectOwnedPlan(deps.db, params.data.id, user.id);
      if (!existing) {
        res.status(404).json({ error: 'PLAN_NOT_FOUND' });
        return;
      }

      if (body.data.status && !isAllowedPlanStatusTransition(existing.status, body.data.status)) {
        res
          .status(400)
          .json(validationIssue(['status'], 'Invalid plan status transition for PATCH'));
        return;
      }

      const hasTreeMetadataMutation =
        body.data.name !== undefined ||
        body.data.start_date !== undefined ||
        body.data.end_date !== undefined ||
        body.data.plan_weeks !== undefined ||
        body.data.source_template_id !== undefined;
      if (existing.status !== 'draft' && hasTreeMetadataMutation) {
        res.status(409).json({ error: 'PLAN_TREE_IMMUTABLE', status: existing.status });
        return;
      }
      // Imported history is intentionally allowed on an un-published draft so
      // a coach can reconcile an old plan.  It must nevertheless make the
      // draft's structure immutable: changing its horizon/template (or the
      // displayed plan metadata) would make the retained logs ambiguous.
      if (existing.status === 'draft' && hasTreeMetadataMutation) {
        const mutationError = await planTreeMutationError(deps.db, existing);
        if (mutationError) {
          res.status(409).json(mutationError);
          return;
        }
      }
      if (
        existing.kind === 'adaptation' &&
        body.data.plan_weeks !== undefined &&
        body.data.plan_weeks !== 1
      ) {
        res
          .status(400)
          .json(validationIssue(['plan_weeks'], 'Adaptation plans must be exactly 1 week'));
        return;
      }

      const mergedStartDate = body.data.start_date ?? existing.start_date;
      const mergedEndDate = body.data.end_date ?? existing.end_date;
      if (mergedEndDate < mergedStartDate) {
        res
          .status(400)
          .json(validationIssue(['end_date'], 'end_date must be on or after start_date'));
        return;
      }

      if (body.data.source_template_id !== undefined) {
        if (existing.source === 'template' && body.data.source_template_id === null) {
          res
            .status(400)
            .json(validationIssue(['source_template_id'], 'source_template_id is required'));
          return;
        }
        if (existing.source !== 'template' && body.data.source_template_id !== null) {
          res
            .status(400)
            .json(validationIssue(['source_template_id'], 'source_template_id must be null'));
          return;
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

      const updated = await deps.db
        .updateTable('plans')
        .set(patch)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      res.status(200).json(toPlan(updated));
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
        // Do not disclose another student's plan.
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
        { planId: plan.id, studentId: user.id, created: result.created, existing: result.existing },
        'imported_history_confirmed',
      );
      res.status(200).json({
        plan_id: plan.id,
        created_set_logs: result.created,
        existing_set_logs: result.existing,
        assumed: true,
      });
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
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
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

      const planId = await planIdForDay(deps.db, params.data.dayId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
        return;
      }

      const day = await deps.db
        .updateTable('plan_days')
        .set(body.data)
        .where('id', '=', params.data.dayId)
        .returningAll()
        .executeTakeFirstOrThrow();

      deps.logger.info(
        { planId, action: 'day', op: 'update', resourceId: day.id },
        'plan_tree_mutated',
      );
      res.status(200).json(toPlanDay(day));
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

      const planId = await planIdForDay(deps.db, params.data.dayId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
        return;
      }

      await deps.db.deleteFrom('plan_days').where('id', '=', params.data.dayId).execute();
      deps.logger.info(
        { planId, action: 'day', op: 'delete', resourceId: params.data.dayId },
        'plan_tree_mutated',
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
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_DAY_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
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

      const planId = await planIdForExercise(deps.db, params.data.exerciseId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
        return;
      }
      if (body.data.exercise_id) {
        const exerciseVisible = await visibleExerciseForCoach(
          deps.db,
          body.data.exercise_id,
          user.id,
        );
        if (!exerciseVisible) {
          res.status(400).json({ error: 'EXERCISE_NOT_FOUND_OR_HIDDEN' });
          return;
        }
      }

      const patch: Updateable<PlanExercisesTable> = {};
      if (body.data.exercise_id !== undefined) patch.exercise_id = body.data.exercise_id;
      if (body.data.is_main_lift !== undefined) patch.is_main_lift = body.data.is_main_lift;
      if (body.data.sort_order !== undefined) patch.sort_order = body.data.sort_order;
      if (body.data.notes !== undefined) patch.notes = body.data.notes;

      const planExercise = await deps.db
        .updateTable('plan_exercises')
        .set(patch)
        .where('id', '=', params.data.exerciseId)
        .returningAll()
        .executeTakeFirstOrThrow();

      deps.logger.info(
        { planId, action: 'exercise', op: 'update', resourceId: planExercise.id },
        'plan_tree_mutated',
      );
      res.status(200).json(toPlanExercise(planExercise));
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

      const planId = await planIdForExercise(deps.db, params.data.exerciseId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
        return;
      }

      await deps.db.deleteFrom('plan_exercises').where('id', '=', params.data.exerciseId).execute();
      deps.logger.info(
        { planId, action: 'exercise', op: 'delete', resourceId: params.data.exerciseId },
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

      const planId = await planIdForExercise(deps.db, params.data.exerciseId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_EXERCISE_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
        return;
      }

      const set = await deps.db
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

      deps.logger.info(
        { planId, action: 'set', op: 'create', resourceId: set.id },
        'plan_tree_mutated',
      );
      res.status(201).json(toPlanSet(set));
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

      const planId = await planIdForSet(deps.db, params.data.setId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_SET_NOT_FOUND' });
        return;
      }
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_SET_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
        return;
      }

      const existing = await deps.db
        .selectFrom('plan_sets')
        .selectAll()
        .where('id', '=', params.data.setId)
        .executeTakeFirstOrThrow();

      const patch: Updateable<PlanSetsTable> = {};
      if (body.data.set_number !== undefined) patch.set_number = body.data.set_number;
      if (body.data.target_reps !== undefined) patch.target_reps = body.data.target_reps;
      if (body.data.target_reps_max !== undefined) {
        patch.target_reps_max = body.data.target_reps_max;
      }
      if (body.data.intensity_mode !== undefined) patch.intensity_mode = body.data.intensity_mode;
      if (body.data.target_value !== undefined) {
        patch.target_value = normalizeTargetValue(body.data.target_value);
      }
      if (body.data.set_type !== undefined) patch.set_type = body.data.set_type;
      if (body.data.rest_seconds !== undefined) patch.rest_seconds = body.data.rest_seconds;
      if (body.data.coach_note !== undefined) patch.coach_note = body.data.coach_note;

      const validation = mergedSetValidation(existing, patch);
      if (validation) {
        res.status(400).json(validation);
        return;
      }

      const set = await deps.db
        .updateTable('plan_sets')
        .set(patch)
        .where('id', '=', params.data.setId)
        .returningAll()
        .executeTakeFirstOrThrow();

      deps.logger.info(
        { planId, action: 'set', op: 'update', resourceId: set.id },
        'plan_tree_mutated',
      );
      res.status(200).json(toPlanSet(set));
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

      const planId = await planIdForSet(deps.db, params.data.setId, user.id);
      if (!planId) {
        res.status(404).json({ error: 'PLAN_SET_NOT_FOUND' });
        return;
      }
      const plan = await selectOwnedPlan(deps.db, planId, user.id);
      if (!plan) {
        res.status(404).json({ error: 'PLAN_SET_NOT_FOUND' });
        return;
      }
      const mutationError = await planTreeMutationError(deps.db, plan);
      if (mutationError) {
        res.status(409).json(mutationError);
        return;
      }

      await deps.db.deleteFrom('plan_sets').where('id', '=', params.data.setId).execute();
      deps.logger.info(
        { planId, action: 'set', op: 'delete', resourceId: params.data.setId },
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
        dbQuery = dbQuery.where('status', 'in', ['published', 'completed', 'paused']);
      }

      const plans = await dbQuery.execute();
      res.status(200).json({ plans: plans.map(toPlan) });
    }),
  );

  return router;
}
