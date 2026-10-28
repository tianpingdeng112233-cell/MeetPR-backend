import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  OutlineSchema,
  WeekSkeletonSchema,
  type PlanImportModel,
  type UsageObserver,
} from './model';
import { OUTLINE_PROMPT, WEEK_PROMPT } from './prompts';
import { PlanImportModelError, runModelCall } from './retry';
import { normalizeOrdinalWeek, prepareCycleOutline } from './day-cycles';

export const DEEPSEEK_TIMEOUT_MS = 60_000;
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

async function dumpResponse(
  stage: 'outline' | 'week',
  rawResponse: string,
  validationError: string | null,
): Promise<void> {
  // Check the runtime env too: direct adapter callers can bypass loadConfig.
  const directory = process.env.PLAN_IMPORT_DEBUG_DIR?.trim();
  if (process.env.NODE_ENV === 'production' || !directory) return;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${new Date().toISOString().replace(/:/g, '-')}-${stage}-${randomUUID()}.json`;
    await writeFile(
      join(directory, filename),
      JSON.stringify({
        stage,
        // Week responses and parser errors can contain unparsed text, including in note.
        raw_response: stage === 'week' ? null : rawResponse,
        validation_error: validationError,
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch {
    // Debug I/O must never affect retries or leak response content via logs.
  }
}

export function createDeepSeekPlanImportModel(options: {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  fetch?: typeof globalThis.fetch;
}): PlanImportModel {
  const fetch = options.fetch ?? globalThis.fetch;
  const url = `${(options.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, '')}/chat/completions`;

  async function complete<T>(
    stage: 'outline' | 'week',
    prompt: string,
    input: unknown,
    validate: (value: unknown) => T,
    onUsage?: UsageObserver,
  ): Promise<T> {
    return runModelCall(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, DEEPSEEK_TIMEOUT_MS);
      timer.unref();
      let rawResponse: string | undefined;
      let validationError: string | null = null;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model ?? DEFAULT_DEEPSEEK_MODEL,
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 8192,
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: JSON.stringify(input) },
            ],
          }),
          signal: controller.signal,
        }).catch(() => {
          throw new PlanImportModelError('MODEL_BUSY');
        });
        rawResponse = await response.text().catch(() => {
          throw new PlanImportModelError('MODEL_BUSY');
        });
        if (!response.ok)
          throw new PlanImportModelError(
            response.status === 429 || response.status >= 500 ? 'MODEL_BUSY' : 'BAD_OUTPUT',
          );
        const raw: unknown = JSON.parse(rawResponse);
        const completion = CompletionSchema.parse(raw);
        if (completion.usage) onUsage?.(completion.usage);
        if (completion.choices[0]?.finish_reason === 'length')
          throw new PlanImportModelError('OUTPUT_TOO_LONG');
        const content = completion.choices[0]?.message.content;
        if (content === undefined || content === null) throw new PlanImportModelError('BAD_OUTPUT');
        return validate(JSON.parse(content) as unknown);
      } catch (error) {
        validationError =
          stage === 'week'
            ? error instanceof PlanImportModelError
              ? error.reason
              : 'BAD_OUTPUT'
            : error instanceof Error
              ? error.message
              : 'BAD_OUTPUT';
        throw error;
      } finally {
        clearTimeout(timer);
        if (rawResponse !== undefined) await dumpResponse(stage, rawResponse, validationError);
      }
    });
  }

  return {
    outline: (input, onUsage) =>
      complete(
        'outline',
        OUTLINE_PROMPT,
        { sheets: input.sheets.map(({ name, cells }) => ({ name, cells })) },
        (value) => {
          const result = OutlineSchema.parse(prepareCycleOutline(value, input.sheets));
          if (!input.sheets.some((sheet) => sheet.name === result.sheet))
            throw new Error('MODEL_UNKNOWN_SHEET');
          return result;
        },
        onUsage,
      ),
    parseWeek: (input, onUsage) =>
      complete(
        'week',
        WEEK_PROMPT,
        { index: input.index, cells: input.cells, header_cells: input.header_cells },
        (value) => {
          if (z.object({ region_suspect: z.literal(true) }).safeParse(value).success)
            throw new PlanImportModelError('REGION_SUSPECT');
          const result = WeekSkeletonSchema.parse(normalizeOrdinalWeek(value, input.cells));
          if (result.index !== input.index) throw new Error('MODEL_UNKNOWN_WEEK');
          return result;
        },
        onUsage,
      ),
  };
}
