import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeepSeekPlanImportModel } from '../../src/services/plan-import/deepseek';

const input = {
  sheets: [{ name: '2026', cells: [[1, 1, '深蹲 4×8 112.5'] as [number, number, string]] }],
};
const outline = { sheet: '2026', header_region: null, weeks: [] };
afterEach(() => {
  vi.useRealTimers();
});

describe('DeepSeek plan import adapter', () => {
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
      days: [{ weekday: 0, rest: true, exercises: [] }],
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
