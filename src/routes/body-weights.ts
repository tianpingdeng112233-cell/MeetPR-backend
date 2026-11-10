import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { deleteBodyWeight, fetchBodyWeights, putBodyWeight } from '../handlers/body-weights';
import { requireRole } from '../middleware/auth';
import { isIsoCalendarDate, isoCalendarDateSchemaMessage, utcDate } from '../utils/date';
import { route, validationEnvelope } from './http';

const DeleteDateSchema = z.string().refine(isIsoCalendarDate, isoCalendarDateSchemaMessage());

const BodySchema = z.object({
  weight_kg: z
    .union([z.string(), z.number()])
    .transform(String)
    .pipe(z.string().regex(/^\d+(\.\d{1,2})?$/, 'Decimal must have at most 2 decimals'))
    .refine(
      (value) => Number(value) > 0 && Number(value) < 500,
      'Value must be greater than 0 and less than 500',
    )
    .transform((value) => Number(value).toFixed(2)),
});

export function bodyWeightsRouter({ db }: { db: Kysely<Database> }): ExpressRouter {
  const router = Router();
  const student = requireRole('coached_student', 'self_train_student');

  router.get(
    '/me/body-weights',
    student,
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      res.status(200).json({ records: await fetchBodyWeights(db, req.user.id) });
    }),
  );

  router.put(
    '/me/body-weights/:date',
    student,
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const date = req.params.date ?? '';
      if (
        !isIsoCalendarDate(date) ||
        Math.abs(utcDate(date).getTime() - utcDate(new Date()).getTime()) > 86_400_000
      ) {
        res.status(400).json({ error: 'BODY_WEIGHT_DATE_OUT_OF_RANGE' });
        return;
      }
      const body = BodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      res.status(200).json(await putBodyWeight(db, req.user.id, date, body.data.weight_kg));
    }),
  );

  router.delete(
    '/me/body-weights/:date',
    student,
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const date = DeleteDateSchema.safeParse(req.params.date);
      if (!date.success) {
        res.status(400).json(validationEnvelope(date.error));
        return;
      }
      const result = await deleteBodyWeight(db, req.user.id, date.data);
      if (!result) {
        res.status(404).json({ error: 'BODY_WEIGHT_NOT_FOUND' });
        return;
      }
      res.status(200).json(result);
    }),
  );
  return router;
}
