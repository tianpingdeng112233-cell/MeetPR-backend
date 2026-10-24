import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { listCustomExercises } from '../handlers/exercise-adoption';
import { CreateExerciseBodySchema } from './exercises/schemas';
import { route, validationEnvelope } from './http';
import { toExercise } from './plans/serialization';

const ExerciseIdSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const ExerciseIdsSchema = z.object({ exercise_ids: z.array(ExerciseIdSchema).min(1).max(50) });
const AdoptSchema = ExerciseIdsSchema.extend({
  target_exercise_id: ExerciseIdSchema.optional(),
  new_official: CreateExerciseBodySchema.optional(),
}).refine((body) => (body.target_exercise_id !== undefined) !== (body.new_official !== undefined), {
  message: 'Supply exactly one of target_exercise_id and new_official',
});

// Mounted below adminRouter's token and live-role checks.
export function adminCustomExercisesRouter(db: Kysely<Database>): ExpressRouter {
  const router = Router();
  router.get(
    '/',
    route(async (_req, res) => {
      res.status(200).json(await listCustomExercises(db));
    }),
  );
  router.post(
    '/adopt',
    route(async (req, res) => {
      const body = AdoptSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const {
        exercise_ids: ids,
        target_exercise_id: targetId,
        new_official: newOfficial,
      } = body.data;
      const result = await db.transaction().execute(async (trx) => {
        // Stable lock order serializes overlapping batches and coach edits/deletes.
        const sources = await trx
          .selectFrom('exercises')
          .selectAll()
          .where('id', 'in', ids)
          .orderBy('id')
          .forUpdate()
          .execute();
        const byId = new Map(sources.map((row) => [row.id, row]));
        const conflicts = [...new Set(ids)].filter((id) => {
          const row = byId.get(id);
          return row?.created_by_coach_id == null || row.canonical_exercise_id !== null;
        });
        if (conflicts.length) return { type: 'conflict', ids: conflicts } as const;
        let official =
          targetId === undefined
            ? undefined
            : await trx
                .selectFrom('exercises')
                .selectAll()
                .where('id', '=', targetId)
                .forUpdate()
                .executeTakeFirst();
        if (
          targetId !== undefined &&
          (official?.created_by_coach_id !== null || official.canonical_exercise_id !== null)
        )
          return { type: 'invalid-target' } as const;
        if (newOfficial) {
          official = await trx
            .insertInto('exercises')
            .values({
              ...newOfficial,
              name_en: newOfficial.name_en ?? null,
              main_lift_family: newOfficial.main_lift_family ?? null,
              created_by_coach_id: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        if (!official) throw new Error('Missing adoption target');
        const rows = await trx
          .updateTable('exercises')
          .set({ canonical_exercise_id: official.id, adopted_at: new Date() })
          .where('id', 'in', ids)
          .returningAll()
          .execute();
        return { type: 'adopted', official, rows } as const;
      });
      if (result.type === 'conflict') {
        res.status(409).json({ error: 'EXERCISE_ADOPTION_CONFLICT', exercise_ids: result.ids });
      } else if (result.type === 'invalid-target') {
        res.status(400).json({ error: 'EXERCISE_ADOPTION_INVALID_TARGET' });
      } else {
        res.status(200).json({
          official: toExercise(result.official),
          rows: result.rows.map((row) => ({
            ...toExercise(row),
            adopted_at: row.adopted_at?.toISOString() ?? null,
          })),
        });
      }
    }),
  );
  router.post(
    '/unadopt',
    route(async (req, res) => {
      const body = ExerciseIdsSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const result = await db.transaction().execute(async (trx) => {
        const sources = await trx
          .selectFrom('exercises')
          .selectAll()
          .where('id', 'in', body.data.exercise_ids)
          .orderBy('id')
          .forUpdate()
          .execute();
        const byId = new Map(sources.map((row) => [row.id, row]));
        const conflicts = [...new Set(body.data.exercise_ids)].filter(
          (id) => !byId.get(id)?.canonical_exercise_id,
        );
        if (conflicts.length) return { type: 'conflict', ids: conflicts } as const;
        const rows = await trx
          .updateTable('exercises')
          .set({ canonical_exercise_id: null, adopted_at: null })
          .where('id', 'in', body.data.exercise_ids)
          .returningAll()
          .execute();
        return { type: 'unadopted', rows } as const;
      });
      if (result.type === 'conflict')
        res.status(409).json({ error: 'EXERCISE_ADOPTION_CONFLICT', exercise_ids: result.ids });
      else res.status(200).json({ rows: result.rows.map((row) => toExercise(row)) });
    }),
  );
  return router;
}
