import type { RequestHandler } from 'express';

import { route, validationEnvelope } from '../routes/http';
import { ApiError } from '../utils/apiError';
import { ensureUser, toVideoAttachmentWithURLs } from './upload-common';
import type { HandlerDeps } from './upload-common';
import { StudentVideosParamSchema } from './upload-schemas';

async function coachHasPublishedPlanForStudent(
  deps: Pick<HandlerDeps, 'db'>,
  coachId: string,
  studentId: string,
): Promise<boolean> {
  const row = await deps.db
    .selectFrom('plans')
    .select('id')
    .where('coach_id', '=', coachId)
    .where('trainee_id', '=', studentId)
    .where('status', '=', 'published')
    .executeTakeFirst();
  return row !== undefined;
}

export function videosFetchHandler(deps: HandlerDeps): RequestHandler {
  return route(async (req, res) => {
    const user = ensureUser(req);
    const params = StudentVideosParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(validationEnvelope(params.error));
      return;
    }

    if (user.id === params.data.id) {
      const rows = await deps.db
        .selectFrom('video_attachments')
        .selectAll()
        .where('student_id', '=', user.id)
        .orderBy('recorded_at', 'desc')
        .execute();
      res.status(200).json({ items: rows.map((row) => toVideoAttachmentWithURLs(row, deps.oss)) });
      return;
    }

    if (user.role !== 'coach') throw new ApiError('AUTHORIZATION_FORBIDDEN', 403);
    if (!(await coachHasPublishedPlanForStudent(deps, user.id, params.data.id))) {
      throw new ApiError('AUTHORIZATION_FORBIDDEN', 403);
    }

    const rows = await deps.db
      .selectFrom('video_attachments')
      .innerJoin('plan_exercises', 'plan_exercises.id', 'video_attachments.plan_exercise_id')
      .innerJoin('plan_days', 'plan_days.id', 'plan_exercises.plan_day_id')
      .innerJoin('plans', 'plans.id', 'plan_days.plan_id')
      .selectAll('video_attachments')
      .where('video_attachments.student_id', '=', params.data.id)
      .where('video_attachments.coach_visible_at', 'is not', null)
      .where('plans.coach_id', '=', user.id)
      .where('plans.trainee_id', '=', params.data.id)
      .where('plans.status', '=', 'published')
      .orderBy('video_attachments.recorded_at', 'desc')
      .execute();

    res.status(200).json({ items: rows.map((row) => toVideoAttachmentWithURLs(row, deps.oss)) });
  });
}
