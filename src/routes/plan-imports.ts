import { Router, type Router as ExpressRouter, type Request, type Response } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Config } from '../config';
import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { requireRole } from '../middleware/auth';
import { OutlineSchema, type Outline, type PlanImportModel } from '../services/plan-import/model';
import {
  claimWeekCall,
  DAILY_LIMIT,
  recordOutline,
  remainingToday,
  shanghaiDay,
} from '../services/plan-import/runs';
import { parseWeeks } from '../services/plan-import/parse-weeks';
import { filterOutlineWeeks } from '../services/plan-import/filter-outline';
import { createDeepSeekPlanImportModel } from '../services/plan-import/deepseek';
import { PlanImportModelError, runModelCall } from '../services/plan-import/retry';
import {
  cellChars,
  MAX_INPUT_CHARS,
  OutlineRequestSchema,
  trimOutline,
  WeeksRequestSchema,
} from '../services/plan-import/input';
import { route } from './http';

export function planImportsRouter(deps: {
  config: Config;
  db: Kysely<Database>;
  logger: Logger;
  planImportModel?: PlanImportModel | undefined;
}): ExpressRouter {
  const router = Router();
  const enabled = Boolean(deps.config.DEEPSEEK_API_KEY?.trim());
  const model =
    deps.planImportModel ??
    (deps.config.DEEPSEEK_API_KEY?.trim()
      ? createDeepSeekPlanImportModel({
          apiKey: deps.config.DEEPSEEK_API_KEY,
          baseUrl: deps.config.DEEPSEEK_BASE_URL,
          model: deps.config.DEEPSEEK_MODEL,
        })
      : undefined);
  const safeRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
    route(async (req, res) => {
      try {
        await handler(req, res);
      } catch {
        // Error objects can contain provider responses or body-parser cell text.
        deps.logger.error({ coach_id: req.user?.id, result_code: 'INTERNAL_ERROR' }, 'plan_import');
        res.status(500).json({ error: 'internal_error' });
      }
    });
  router.use(requireRole('coach'));
  router.get(
    '/status',
    safeRoute(async (req, res) => {
      const query = z.object({ trainee_id: z.string().uuid() }).strict().safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR' });
        return;
      }
      if (!req.user || !(await hasAcceptedBond(deps.db, req.user.id, query.data.trainee_id))) {
        res.status(404).json({ error: 'TRAINEE_NOT_FOUND' });
        return;
      }
      res.json({
        enabled,
        daily_limit: DAILY_LIMIT,
        remaining_today: enabled
          ? await remainingToday(deps.db, req.user.id, query.data.trainee_id)
          : 0,
      });
    }),
  );
  router.post(
    '/',
    safeRoute(async (req, res) => {
      const startedAt = Date.now();
      if (!enabled || !model) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = OutlineRequestSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR' });
        return;
      }
      if (!req.user || !(await hasAcceptedBond(deps.db, req.user.id, body.data.trainee_id))) {
        res.status(404).json({ error: 'TRAINEE_NOT_FOUND' });
        return;
      }
      if (body.data.sheets.length === 0) {
        res.status(422).json({ error: 'NO_TRAINING_WEEKS' });
        return;
      }
      const inputChars = body.data.sheets.reduce((sum, sheet) => sum + cellChars(sheet.cells), 0);
      if (inputChars > MAX_INPUT_CHARS) {
        res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      const trimmed = trimOutline(body.data.sheets);
      if (!trimmed) {
        res.status(413).json({ error: 'IMPORT_HEADERS_TOO_LARGE' });
        return;
      }
      const quotaError = () =>
        res.status(429).json({ error: 'IMPORT_DAILY_LIMIT', remaining_today: 0 });
      if ((await remainingToday(deps.db, req.user.id, body.data.trainee_id)) === 0) {
        quotaError();
        return;
      }
      const usage = { prompt_tokens: 0, completion_tokens: 0 };
      let result: Outline;
      try {
        result = await runModelCall(async () => {
          const output = OutlineSchema.parse(
            await model.outline({ sheets: trimmed.sheets }, (tokens) => {
              usage.prompt_tokens += tokens.prompt_tokens;
              usage.completion_tokens += tokens.completion_tokens;
            }),
          );
          if (!body.data.sheets.some((sheet) => sheet.name === output.sheet))
            throw new Error('MODEL_UNKNOWN_SHEET');
          return output;
        });
      } catch (error) {
        deps.logger.info(
          {
            coach_id: req.user.id,
            input_chars: inputChars,
            ...usage,
            duration_ms: Date.now() - startedAt,
            result_code: 'PARSE_FAILED',
          },
          'plan_import',
        );
        const reason =
          error instanceof PlanImportModelError && error.reason !== 'REGION_SUSPECT'
            ? error.reason
            : 'BAD_OUTPUT';
        res.status(502).json({ error: 'PARSE_FAILED', reason });
        return;
      }
      result = filterOutlineWeeks(
        result,
        body.data.sheets.find((sheet) => sheet.name === result.sheet)?.cells ?? [],
      );
      if (result.weeks.length === 0) {
        res.status(422).json({ error: 'NO_TRAINING_WEEKS' });
        return;
      }
      const run = await recordOutline(deps.db, {
        coach_id: req.user.id,
        trainee_id: body.data.trainee_id,
        source: body.data.source,
        input_chars: inputChars,
        ...usage,
      });
      if (!run) {
        quotaError();
        return;
      }
      deps.logger.info(
        {
          coach_id: req.user.id,
          import_id: run.id,
          input_chars: inputChars,
          ...usage,
          duration_ms: Date.now() - startedAt,
          result_code: 'OK',
        },
        'plan_import',
      );
      res.json({ import_id: run.id, ...result, truncated_rows: trimmed.truncated_rows });
    }),
  );
  router.post(
    '/:import_id/weeks',
    safeRoute(async (req, res) => {
      const startedAt = Date.now();
      if (!enabled || !model || !req.user) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const id = z.string().uuid().safeParse(req.params.import_id);
      const body = WeeksRequestSchema.safeParse(req.body);
      if (!id.success || !body.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR' });
        return;
      }
      const inputChars =
        cellChars(body.data.header_cells) +
        body.data.weeks.reduce((sum, week) => sum + cellChars(week.cells), 0);
      if (inputChars > MAX_INPUT_CHARS) {
        res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      const { start, end } = shanghaiDay();
      const run = await deps.db
        .selectFrom('plan_import_runs')
        .select(['trainee_id'])
        .where('id', '=', id.data)
        .where('coach_id', '=', req.user.id)
        .where('created_at', '>=', start)
        .where('created_at', '<', end)
        .executeTakeFirst();
      if (!run || !(await hasAcceptedBond(deps.db, req.user.id, run.trainee_id))) {
        res.status(404).json({ error: 'IMPORT_NOT_FOUND' });
        return;
      }
      if (!(await claimWeekCall(deps.db, req.user.id, id.data))) {
        res.status(409).json({ error: 'IMPORT_WEEK_CALL_LIMIT' });
        return;
      }
      const usage = { prompt_tokens: 0, completion_tokens: 0 };
      const weeks = await parseWeeks(
        model,
        body.data.weeks.map((week) => ({ ...week, header_cells: body.data.header_cells })),
        (tokens) => {
          usage.prompt_tokens += tokens.prompt_tokens;
          usage.completion_tokens += tokens.completion_tokens;
        },
      );
      await deps.db
        .updateTable('plan_import_runs')
        .set((eb) => ({
          prompt_tokens: eb('prompt_tokens', '+', usage.prompt_tokens),
          completion_tokens: eb('completion_tokens', '+', usage.completion_tokens),
        }))
        .where('id', '=', id.data)
        .execute();
      deps.logger.info(
        {
          coach_id: req.user.id,
          import_id: id.data,
          ...usage,
          input_chars: inputChars,
          duration_ms: Date.now() - startedAt,
          result_code: weeks.some((week) => 'error' in week) ? 'PARSE_FAILED' : 'OK',
        },
        'plan_import',
      );
      res.json({ weeks });
    }),
  );
  return router;
}
