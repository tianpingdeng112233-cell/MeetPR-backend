import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, ExercisesTable } from '../../db/types';
import { requireRole } from '../../middleware/auth';
import { route, validationEnvelope } from '../http';
import { toExercise } from '../plans/serialization';
import { CreateExerciseBodySchema, ExerciseQuerySchema } from './schemas';

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
          main_lift_family: body.data.main_lift_family ?? null,
          created_by_coach_id: req.user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      res.status(201).json(toExercise(row));
    }),
  );

  return router;
}
