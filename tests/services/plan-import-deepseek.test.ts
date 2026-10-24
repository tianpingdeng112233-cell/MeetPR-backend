import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { createDeepSeekPlanImportModel } from '../../src/services/plan-import/deepseek';

const input = {
  sheets: [{ name: '2026', cells: [[1, 1, '深蹲 4×8 112.5'] as [number, number, string]] }],
};
const outline = { sheet: '2026', header_region: null, weeks: [] };
const outlinedWeek = {
  index: 0,
  label: 'W1',
  start_date: null,
  training_days: 4,
  region: { r1: 1, c1: 1, r2: 16, c2: 8 },
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('DeepSeek plan import adapter', () => {
  it('normalizes a day-only response with all empty hints together', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...outline,
                  header_region: {},
                  weeks: [{ ...outlinedWeek, index: 1, label: null, start_date: '' }],
                }),
              },
            },
          ],
        }),
      ),
    );
    const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    await expect(
      model.outline({
        sheets: [
          {
            name: '2026',
            cells: [
              [1, 1, 'Day1 槓鈴深蹲'],
              [5, 1, 'Day2 臥推'],
              [9, 1, 'Day3 硬舉'],
              [13, 1, 'Day4 臥推'],
            ],
          },
        ],
      }),
    ).resolves.toEqual({ ...outline, weeks: [outlinedWeek] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves valid dates, labels and regions while rejecting broken outlines', async () => {
    const valid = {
      ...outline,
      header_region: outlinedWeek.region,
      weeks: [{ ...outlinedWeek, label: '第1周', start_date: '2024-02-29' }],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] }),
        ),
      );
    const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    await expect(model.outline(input)).resolves.toEqual(valid);
    const broken: unknown[] = [
      { ...valid, sheet: undefined },
      { ...valid, sheet: '' },
      { ...valid, sheet: 'unknown' },
      { ...valid, header_region: { r1: 1 } },
      { ...valid, header_region: [] },
      { ...valid, weeks: [outlinedWeek, outlinedWeek] },
      ...[
        { index: -1 },
        { index: 1.5 },
        { label: 12 },
        { region: {} },
        { region: { r1: 3, c1: 1, r2: 2, c2: 4 } },
        { region: { r1: 1, c1: 3, r2: 2, c2: 1 } },
      ].map((fields) => ({ ...valid, weeks: [{ ...outlinedWeek, ...fields }] })),
    ];
    for (const result of broken) {
      fetch.mockClear().mockImplementation(() =>
        Promise.resolve(
          Response.json({
            choices: [{ message: { content: JSON.stringify(result) } }],
          }),
        ),
      );
      await expect(model.outline(input)).rejects.toMatchObject({ reason: 'BAD_OUTPUT' });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    fetch.mockClear().mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ index: 0, start_date: '2024-02-29', days: [] }),
            },
          },
        ],
      }),
    );
    await expect(model.parseWeek({ index: 0, cells: [], header_cells: [] })).resolves.toMatchObject(
      { start_date: '2024-02-29' },
    );
  });
  it.each([
    ['development', true, 2],
    ['test', true, 2],
    ['development', false, 0],
    ['production', true, 0],
  ] as const)(
    'debug dumps in %s with env set=%s produce %i files',
    async (nodeEnv, enabled, count) => {
      const directory = await mkdtemp(join(tmpdir(), 'plan-import-debug-test-'));
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('PLAN_IMPORT_DEBUG_DIR', enabled ? directory : undefined);
      try {
        const responses = [outline, { index: 0, start_date: null, days: [] }].map((result) =>
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }),
        );
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(new Response(responses[0]))
          .mockResolvedValueOnce(new Response(responses[1]));
        const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
        await model.outline(input);
        await model.parseWeek({ index: 0, cells: [], header_cells: [] });
        const files = await readdir(directory);
        expect(files).toHaveLength(count);
        if (count > 0) {
          for (const file of files) expect(file).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.json$/);
          const dumps = await Promise.all(
            files.map(
              async (file) => JSON.parse(await readFile(join(directory, file), 'utf8')) as unknown,
            ),
          );
          expect(dumps).toEqual(
            expect.arrayContaining([
              { stage: 'outline', raw_response: responses[0], validation_error: null },
              { stage: 'week', raw_response: responses[1], validation_error: null },
            ]),
          );
          expect(JSON.stringify(dumps)).not.toContain('test-placeholder');
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('debug dumps every failed validation attempt with the validation error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plan-import-debug-test-'));
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PLAN_IMPORT_DEBUG_DIR', directory);
    try {
      const raw = JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ...outline, sheet: null }) } }],
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() => Promise.resolve(new Response(raw)));
      const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
      await expect(model.outline(input)).rejects.toMatchObject({
        message: 'PARSE_FAILED',
        reason: 'BAD_OUTPUT',
      });
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(JSON.parse(await readFile(join(directory, file), 'utf8'))).toEqual({
          stage: 'outline',
          raw_response: raw,
          validation_error: expect.stringContaining('sheet'),
        });
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('accepts the debug directory in development config and rejects it in production', () => {
    const env = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://test:test@localhost/test',
      JWT_ACCESS_SECRET: 'a'.repeat(48),
      JWT_REFRESH_SECRET: 'b'.repeat(48),
      PLAN_IMPORT_DEBUG_DIR: '/tmp/plan-import-debug-test',
    };
    expect(loadConfig(env)).toHaveProperty('PLAN_IMPORT_DEBUG_DIR', env.PLAN_IMPORT_DEBUG_DIR);
    expect(() => loadConfig({ ...env, NODE_ENV: 'production' })).toThrow('PLAN_IMPORT_DEBUG_DIR');
  });
  it.each([
    [1, 2],
    [4, 8],
    [2, 0],
  ])('renumbers unique week indices %j, %j in table order', async (first, second) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...outline,
                  weeks: [
                    { ...outlinedWeek, index: first, label: null },
                    { ...outlinedWeek, index: second, label: '' },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    );
    const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    await expect(model.outline(input)).resolves.toEqual({
      ...outline,
      weeks: [outlinedWeek, { ...outlinedWeek, index: 1, label: 'W2' }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{}, undefined])(
    'defaults an empty or missing header_region %j',
    async (header_region) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...outline,
                    header_region,
                    weeks: [outlinedWeek],
                  }),
                },
              },
            ],
          }),
        ),
      );
      const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
      await expect(model.outline(input)).resolves.toEqual({ ...outline, weeks: [outlinedWeek] });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['', 'next Monday', '2026-02-30', '2026-1-5', '2026-01-05T00:00:00Z'])(
    'normalizes invalid start_date %j in outline and week results',
    async (start_date) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...outline,
                    weeks: [{ ...outlinedWeek, start_date }],
                  }),
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    index: 0,
                    start_date,
                    days: [],
                  }),
                },
              },
            ],
          }),
        );
      const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
      await expect(model.outline(input)).resolves.toEqual({ ...outline, weeks: [outlinedWeek] });
      await expect(model.parseWeek({ index: 0, cells: [], header_cells: [] })).resolves.toEqual({
        index: 0,
        start_date: null,
        days: [],
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([{ label: '' }, { label: null }, { label: '   ' }])(
    'defaults a day-only outline label %j',
    async (fields) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...outline,
                    weeks: [{ ...outlinedWeek, ...fields }],
                  }),
                },
              },
            ],
          }),
        ),
      );
      const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
      await expect(model.outline(input)).resolves.toEqual({ ...outline, weeks: [outlinedWeek] });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('requests an 8192-token output budget for both outline and week parsing', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: JSON.stringify(outline) } }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            { message: { content: JSON.stringify({ index: 0, start_date: null, days: [] }) } },
          ],
        }),
      );
    const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    await model.outline(input);
    await model.parseWeek({ index: 0, cells: [], header_cells: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    const prompts = fetch.mock.calls.map(([, init]) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
      return body.messages[0].content as string;
    });
    expect(prompts[0]).toContain('Day1');
    expect(prompts[0]).toContain('一周');
    expect(prompts[1]).toContain('简体中文');
    for (const [, init] of fetch.mock.calls) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
      expect(body.max_tokens).toBe(8192);
    }
  });
  it.each([
    [429, 'stop', '{}', 'MODEL_BUSY'],
    [503, 'stop', '{}', 'MODEL_BUSY'],
    [200, 'length', '{"index":', 'OUTPUT_TOO_LONG'],
    [200, 'stop', 'not JSON', 'BAD_OUTPUT'],
    [200, 'stop', '{"index":0}', 'BAD_OUTPUT'],
    [200, 'stop', '{"region_suspect":true}', 'REGION_SUSPECT'],
  ])(
    'classifies upstream status %s / %s / %s as %s after one retry',
    async (status, finishReason, content, reason) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() =>
          Promise.resolve(
            Response.json(
              { choices: [{ finish_reason: finishReason, message: { content } }] },
              { status },
            ),
          ),
        );
      const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
      await expect(
        model.parseWeek({ index: 0, cells: [], header_cells: [] }),
      ).rejects.toMatchObject({ reason });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('classifies a network failure as MODEL_BUSY without retaining its message', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('private network response'));
    const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    await expect(model.parseWeek({ index: 0, cells: [], header_cells: [] })).rejects.toMatchObject({
      reason: 'MODEL_BUSY',
      message: 'PARSE_FAILED',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('aborts each attempt at 60 seconds and stops after two attempts', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('private provider payload'));
          });
        }),
    );
    const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    const completed = expect(model.outline(input)).rejects.toMatchObject({
      message: 'PARSE_FAILED',
      reason: 'MODEL_BUSY',
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await completed;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['invalid-json', 'invalid-schema', 'http-error', 'wrong-index'])(
    'retries %s once without exposing provider output',
    async (failure) => {
      const content =
        failure === 'invalid-json'
          ? 'private invalid output'
          : JSON.stringify(
              failure === 'wrong-index' ? { index: 1, start_date: null, days: [] } : { index: 0 },
            );
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() =>
          Promise.resolve(
            Response.json(
              { choices: [{ message: { content } }] },
              { status: failure === 'http-error' ? 503 : 200 },
            ),
          ),
        );
      const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
      await expect(model.parseWeek({ index: 0, cells: [], header_cells: [] })).rejects.toThrow(
        'PARSE_FAILED',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('supports custom base URL/model and forwards only week cells and headers', async () => {
    const result = {
      index: 0,
      start_date: null,
      days: [{ weekday: 0, day_index: 1, rest: true, exercises: [] }],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] }),
      );
    const model = createDeepSeekPlanImportModel({
      apiKey: 'test-placeholder',
      fetch,
      baseUrl: 'https://example.test/v1/',
      model: 'configured-model',
    });
    const week = {
      index: 0,
      cells: input.sheets[0]?.cells ?? [],
      header_cells: [],
      filename: 'private.xlsx',
    };
    expect(await model.parseWeek(week)).toEqual(result);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
    expect(body.model).toBe('configured-model');
    expect(body.messages[0].content).toContain('intensity_kind');
    expect(body.messages[0].content).toContain('intensity_values');
    expect(body.messages[0].content).toContain('weight_values');
    expect(body.messages[0].content).not.toMatch(/若有铺满各组[^。]*必须加 inferred/);
    expect(body.messages[0].content).toContain('铺满各组不算推断，不得加 inferred');
    expect(body.messages[0].content).toContain(
      '只有计算或展开后、在这一周 cells 文本里找不到的数字，才必须加 inferred',
    );
    expect(JSON.parse(body.messages[1].content)).toEqual({
      index: 0,
      cells: week.cells,
      header_cells: [],
    });
    expect(init?.body).not.toContain('private.xlsx');
  });
  it('sends JSON mode with temperature zero and a 60s deadline; retries invalid JSON once', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'invalid JSON' } }] }))
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: JSON.stringify(outline) } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      );
    const model = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    const onUsage = vi.fn();
    expect(await model.outline(input, onUsage)).toEqual(outline);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, options] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(options?.method).toBe('POST');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(typeof options?.body === 'string' ? options.body : '');
    expect(body).toMatchObject({
      model: 'deepseek-chat',
      response_format: { type: 'json_object' },
      temperature: 0,
    });
    expect(body.messages[0].content).toContain('JSON');
    expect(JSON.parse(body.messages[1].content)).toEqual(input);
    expect(onUsage).toHaveBeenLastCalledWith({ prompt_tokens: 20, completion_tokens: 10 });
  });
});
