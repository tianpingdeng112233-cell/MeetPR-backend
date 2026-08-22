import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, ExercisesTable } from '../../db/types';
import { getCoachExerciseUsage } from '../../handlers/exercise-usage';
import { requireRole } from '../../middleware/auth';
import { route, validationEnvelope } from '../http';
import { toExercise } from '../plans/serialization';
import {
  CreateExerciseBodySchema,
  ExerciseIdParamSchema,
  ExerciseQuerySchema,
  PatchExerciseBodySchema,
} from './schemas';

interface ExerciseRouterDeps {
  db: Kysely<Database>;
}

type ExerciseRow = Selectable<ExercisesTable>;

function textArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(values)}]::TEXT[]`;
}

function addArrayOverlapFilter<T>(
  query: T,
  column: 'muscle_groups' | 'equipment' | 'movement_pattern',
  values: readonly string[] | undefined,
): T {
  if (!values || values.length === 0) return query;
  return (query as { where: (condition: unknown) => T }).where(
    sql<boolean>`${sql.ref(column)} && ${textArray(values)}`,
  );
}

function visibleExerciseQuery(db: Kysely<Database>, userId: string, role: string) {
  let query = db.selectFrom('exercises').selectAll();

  if (role === 'coach') {
    query = query.where((eb) =>
      eb.or([eb('created_by_coach_id', 'is', null), eb('created_by_coach_id', '=', userId)]),
    );
    return query;
  }

  return query.where((eb) =>
    eb.or([
      eb('created_by_coach_id', 'is', null),
      eb(
        'id',
        'in',
        eb
          .selectFrom('plan_exercises')
          .innerJoin('plan_days', 'plan_days.id', 'plan_exercises.plan_day_id')
          .innerJoin('plans', 'plans.id', 'plan_days.plan_id')
          .select('plan_exercises.exercise_id')
          .where('plans.trainee_id', '=', userId)
          .where('plans.status', '=', 'published'),
      ),
    ]),
  );
}

export async function visibleExerciseForCoach(
  db: Kysely<Database>,
  exerciseId: string,
  coachId: string,
): Promise<ExerciseRow | undefined> {
  return visibleExerciseQuery(db, coachId, 'coach').where('id', '=', exerciseId).executeTakeFirst();
}

export async function visibleExercisesForCoach(
  db: Kysely<Database>,
  exerciseIds: string[],
  coachId: string,
): Promise<Set<string>> {
  if (exerciseIds.length === 0) return new Set();
  const rows = await visibleExerciseQuery(db, coachId, 'coach')
    .select('id')
    .where('id', 'in', exerciseIds)
    .execute();
  return new Set(rows.map((row) => row.id));
}

export function exercisesRouter(deps: ExerciseRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/usage-stats',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      res.status(200).json(await getCoachExerciseUsage(deps.db, req.user.id));
    }),
  );

  router.get(
    '/',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const queryParams = ExerciseQuerySchema.safeParse(req.query);
      if (!queryParams.success) {
        res.status(400).json(validationEnvelope(queryParams.error));
        return;
      }

      let query = visibleExerciseQuery(deps.db, req.user.id, req.user.role);
      query = addArrayOverlapFilter(query, 'muscle_groups', queryParams.data.muscle_group);
      query = addArrayOverlapFilter(query, 'equipment', queryParams.data.equipment);
      query = addArrayOverlapFilter(query, 'movement_pattern', queryParams.data.movement_pattern);

      if (queryParams.data.exercise_type && queryParams.data.exercise_type.length > 0) {
        query = query.where('exercise_type', 'in', queryParams.data.exercise_type);
      }
      if (queryParams.data.main_lift_family && queryParams.data.main_lift_family.length > 0) {
        query = query.where('main_lift_family', 'in', queryParams.data.main_lift_family);
      }

      const rows = await query
        .orderBy('exercise_type', 'asc')
        .orderBy('main_lift_family', 'asc')
        .orderBy('name', 'asc')
        .execute();

      res.status(200).json({ exercises: rows.map(toExercise) });
    }),
  );

  router.post(
    '/',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = CreateExerciseBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const row = await deps.db
        .insertInto('exercises')
        .values({
          ...body.data,
          name_en: body.data.name_en ?? null,
          main_lift_family: body.data.main_lift_family ?? null,
          created_by_coach_id: req.user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      res.status(201).json(toExercise(row));
    }),
  );

  router.patch(
    '/:id',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = ExerciseIdParamSchema.safeParse(req.params);
      const body = PatchExerciseBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const existing = await deps.db
        .selectFrom('exercises')
        .selectAll()
        .where('id', '=', params.data.id)
        .where('created_by_coach_id', '=', req.user.id)
        .executeTakeFirst();
      if (!existing) {
        res.status(404).json({ error: 'EXERCISE_NOT_FOUND' });
        return;
      }

      const finalState = CreateExerciseBodySchema.safeParse({
        name: body.data.name ?? existing.name,
        name_en: body.data.name_en !== undefined ? body.data.name_en : existing.name_en,
        exercise_type: body.data.exercise_type ?? existing.exercise_type,
        main_lift_family:
          body.data.main_lift_family !== undefined
            ? body.data.main_lift_family
            : existing.main_lift_family,
        is_competition_lift: body.data.is_competition_lift ?? existing.is_competition_lift,
        muscle_groups: body.data.muscle_groups ?? existing.muscle_groups,
        equipment: body.data.equipment ?? existing.equipment,
        movement_pattern: body.data.movement_pattern ?? existing.movement_pattern,
      });
      if (!finalState.success) {
        res.status(400).json(validationEnvelope(finalState.error));
        return;
      }

      const row = await deps.db
        .updateTable('exercises')
        .set({
          name: finalState.data.name,
          name_en: finalState.data.name_en ?? null,
          exercise_type: finalState.data.exercise_type,
          main_lift_family: finalState.data.main_lift_family ?? null,
          is_competition_lift: finalState.data.is_competition_lift,
          muscle_groups: finalState.data.muscle_groups,
          equipment: finalState.data.equipment,
          movement_pattern: finalState.data.movement_pattern,
        })
        .where('id', '=', existing.id)
        .where('created_by_coach_id', '=', req.user.id)
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        res.status(404).json({ error: 'EXERCISE_NOT_FOUND' });
        return;
      }

      res.status(200).json(toExercise(row));
    }),
  );

  router.delete(
    '/:id',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = ExerciseIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const coachId = req.user.id;

      const result = await deps.db.transaction().execute(async (trx) => {
        const exercise = await trx
          .selectFrom('exercises')
          .select('id')
          .where('id', '=', params.data.id)
          .where('created_by_coach_id', '=', coachId)
          .forUpdate()
          .executeTakeFirst();
        if (!exercise) return { type: 'not-found' } as const;

        const planUsage = await trx
          .selectFrom('plan_exercises as pe')
          .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
          .select(sql<string>`count(distinct pd.plan_id)`.as('plan_count'))
          .where('pe.exercise_id', '=', exercise.id)
          .executeTakeFirstOrThrow();
        const logUsage = await trx
          .selectFrom('set_logs')
          .select((eb) => eb.fn.countAll<string>().as('log_count'))
          .where('exercise_id', '=', exercise.id)
          .executeTakeFirstOrThrow();
        const planCount = Number(planUsage.plan_count);
        const logCount = Number(logUsage.log_count);

        if (planCount > 0 || logCount > 0) {
          return { type: 'in-use', planCount, logCount } as const;
        }

        await trx.deleteFrom('exercises').where('id', '=', exercise.id).execute();
        return { type: 'deleted' } as const;
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'EXERCISE_NOT_FOUND' });
        return;
      }
      if (result.type === 'in-use') {
        res.status(409).json({
          error: 'EXERCISE_IN_USE',
          plan_count: result.planCount,
          log_count: result.logCount,
        });
        return;
      }

      res.status(204).send();
    }),
  );

  return router;
}
