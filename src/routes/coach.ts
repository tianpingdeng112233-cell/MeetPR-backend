import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { listCoachStudents, renameCoachStudent } from '../handlers/coach-students';
import { requireRole } from '../middleware/auth';
import { notImplemented } from '../utils/notImplemented';
import { route, validationEnvelope } from './http';

interface CoachRouterDeps {
  db: Kysely<Database>;
}

const StudentIdParamsSchema = z.object({ id: z.string().uuid() });
const RenameStudentBodySchema = z
  .object({
    display_name: z.string().trim().min(1).max(100),
  })
  .strict();

export function coachRouter(deps: CoachRouterDeps): Router {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    notImplemented(res, 'GET /coach/dashboard');
  });

  router.get(
    '/students',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const students = await listCoachStudents(deps.db, req.user.id);
      res.status(200).json({ students });
    }),
  );

  router.patch(
    '/students/:id',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = StudentIdParamsSchema.safeParse(req.params);
      const body = RenameStudentBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const student = await renameCoachStudent(
        deps.db,
        req.user.id,
        params.data.id,
        body.data.display_name,
      );
      if (!student) {
        res.status(404).json({ error: 'COACH_STUDENT_NOT_FOUND' });
        return;
      }

      res.status(200).json(student);
    }),
  );

  return router;
}
