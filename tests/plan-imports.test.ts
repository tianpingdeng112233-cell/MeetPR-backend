import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { createDeepSeekPlanImportModel } from '../src/services/plan-import/deepseek';
import { PlanImportModelError } from '../src/services/plan-import/retry';
import type {
  PlanImportModel,
  Outline,
  WeekInput,
  WeekResult,
} from '../src/services/plan-import/model';

import { request } from './helpers/inMemoryRequest';
import { auth, config, ids, makeContext, type TestContext } from './helpers/studentActions';

const outline: Outline = {
  sheet: '2026',
  header_region: null,
  weeks: [
    {
      index: 0,
      label: 'W1',
      start_date: null,
      training_days: 1,
      region: { r1: 1, c1: 1, r2: 3, c2: 4 },
    },
  ],
};
const input = {
  trainee_id: ids.trainee,
  source: 'file',
  sheets: [{ name: '2026', cells: [[1, 1, '深蹲 4×8 112.5']] }],
};
const weekResult = (index: number): WeekResult => ({
  index,
  start_date: null,
  days: [
    {
      weekday: 0,
      rest: false,
      exercises: [
        {
          name: '深蹲',
          sets: 4,
          reps: '8',
          mode: 'kg',
          values: ['112.5', '112.5', '112.5', '112.5'],
          note: '',
          family_guess: 'squat',
          flags: [],
        },
      ],
    },
  ],
});

async function enabledContext(model: PlanImportModel, logger = pino({ level: 'silent' })) {
  const ctx = await makeContext();
  contexts.push(ctx);
  await sql.raw(readFileSync('db/migrations/0076-plan-import-runs.sql', 'utf8')).execute(ctx.db);
  ctx.app = createApp({
    db: ctx.db,
    logger,
    config: { ...config, DEEPSEEK_API_KEY: 'test-placeholder' },
    planImportModel: model,
  });
  return ctx;
}

const contexts: TestContext[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.db.destroy()));
});

describe('coach plan imports', () => {
  it.each(['MODEL_BUSY', 'OUTPUT_TOO_LONG'] as const)(
    'returns outline failure reason %s without counting quota',
    async (reason) => {
      const model = {
        outline: vi.fn().mockRejectedValue(new PlanImportModelError(reason)),
        parseWeek: vi.fn(),
      };
      const ctx = await enabledContext(model);
      const response = await request(ctx.app)
        .post('/coach/plan-imports')
        .set(auth(ctx.coachToken))
        .send(input);
      expect(response.status).toBe(502);
      expect(response.body).toEqual({ error: 'PARSE_FAILED', reason });
      expect(model.outline).toHaveBeenCalledTimes(2);
      const status = await request(ctx.app)
        .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
        .set(auth(ctx.coachToken));
      expect(status.body.remaining_today).toBe(3);
    },
  );
  it('does not multiply the adapter retry at the HTTP orchestration boundary', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }),
        ),
      );
    const adapter = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
    const ctx = await enabledContext({
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: adapter.parseWeek,
    });
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const response = await request(ctx.app)
      .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
      .set(auth(ctx.coachToken))
      .send({ header_cells: [], weeks: [{ index: 0, cells: input.sheets[0]?.cells }] });
    expect(response.body).toEqual({
      weeks: [{ index: 0, error: 'PARSE_FAILED', reason: 'OUTPUT_TOO_LONG' }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('scopes quota to both coach and trainee', async () => {
    const model = { outline: vi.fn().mockResolvedValue(outline), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    for (let i = 0; i < 3; i++)
      await request(ctx.app).post('/coach/plan-imports').set(auth(ctx.coachToken)).send(input);
    expect(
      (
        await request(ctx.app)
          .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
          .set(auth(ctx.otherCoachToken))
      ).body.remaining_today,
    ).toBe(3);
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.coach,
        status: 'accepted',
        expired_at: new Date(),
      })
      .execute();
    expect(
      (
        await request(ctx.app)
          .get(`/coach/plan-imports/status?trainee_id=${ids.otherStudent}`)
          .set(auth(ctx.coachToken))
      ).body.remaining_today,
    ).toBe(3);
  });
  it('accepts edited cells, enforces twelve distinct weeks, and does not log successful cell text', async () => {
    const logs: string[] = [];
    const logger = pino(
      { level: 'info' },
      {
        write: (line) => {
          logs.push(line);
        },
      },
    );
    const model = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn(({ index }: WeekInput) => Promise.resolve(weekResult(index))),
    };
    const ctx = await enabledContext(model, logger);
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const path = `/coach/plan-imports/${String(created.body.import_id)}/weeks`;
    const cells = [[1, 1, 'PRIVATE_EDITED_CELL 4×8 112.5']];
    const weeks = Array.from({ length: 12 }, (_, index) => ({ index, cells }));
    const post = (body: unknown) =>
      request(ctx.app).post(path).set(auth(ctx.coachToken)).send(body);
    expect((await post({ header_cells: [], weeks: [...weeks, { index: 12, cells }] })).status).toBe(
      400,
    );
    expect(
      (
        await post({
          header_cells: [],
          weeks: [
            { index: 0, cells },
            { index: 0, cells },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ header_cells: [[1, 1, 'x'.repeat(400001)]], weeks: [{ index: 0, cells }] }))
        .status,
    ).toBe(413);
    expect(model.parseWeek).not.toHaveBeenCalled();
    expect((await post({ header_cells: [], weeks })).status).toBe(200);
    expect(model.parseWeek.mock.calls[0]?.[0].cells).toEqual(cells);
    expect(logs.join('')).not.toContain('PRIVATE_EDITED_CELL');
    expect(logs.join('')).not.toContain('深蹲');
  });
  it.each(['MODEL_BUSY', 'OUTPUT_TOO_LONG', 'BAD_OUTPUT', 'REGION_SUSPECT'] as const)(
    'returns safe %s for the failed week while keeping its neighbour',
    async (reason) => {
      const model: PlanImportModel = {
        outline: vi.fn().mockResolvedValue(outline),
        parseWeek: vi.fn(({ index }: WeekInput) =>
          index === 0
            ? Promise.reject(new PlanImportModelError(reason))
            : Promise.resolve(weekResult(index)),
        ),
      };
      const ctx = await enabledContext(model);
      const created = await request(ctx.app)
        .post('/coach/plan-imports')
        .set(auth(ctx.coachToken))
        .send(input);
      const response = await request(ctx.app)
        .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
        .set(auth(ctx.coachToken))
        .send({
          header_cells: [],
          weeks: [0, 1].map((index) => ({ index, cells: input.sheets[0]?.cells })),
        });
      expect(response.status).toBe(200);
      expect(response.body.weeks).toEqual([
        { index: 0, error: 'PARSE_FAILED', reason },
        weekResult(1),
      ]);
      expect(model.parseWeek).toHaveBeenCalledTimes(3);
    },
  );
  it('caps cell text at 400k characters and retains headers plus newest rows within the outline budget', async () => {
    const model = { outline: vi.fn().mockResolvedValue(outline), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    const cells = Array.from({ length: 1000 }, (_, index) => [index + 1, 1, '深'.repeat(400)]);
    const body = { ...input, sheets: [{ name: '2026', cells }] };
    const response = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(body);
    expect(response.status).toBe(200);
    const forwarded = model.outline.mock.calls[0]?.[0].sheets[0].cells as [
      number,
      number,
      string,
    ][];
    expect(forwarded.slice(0, 40).map((cell) => cell[0])).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    expect(forwarded.at(-1)?.[0]).toBe(1000);
    expect(forwarded.reduce((sum, cell) => sum + cell[2].length, 0)).toBeLessThanOrEqual(60_000);
    expect(response.body.truncated_rows).toBe(1000 - forwarded.length);
    expect(response.body.truncated_rows).toBeGreaterThan(0);
    const over = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send({ ...input, sheets: [{ name: '2026', cells: [[1, 1, 'x'.repeat(400_001)]] }] });
    expect(over.status).toBe(413);
    expect(model.outline).toHaveBeenCalledTimes(1);
  });
  it('does not count failed outlines, retries once, and never logs or returns model error text', async () => {
    const privateText = 'PRIVATE_CELL_SENTINEL_深蹲';
    const logs: string[] = [];
    const logger = pino(
      { level: 'info' },
      {
        write: (line) => {
          logs.push(line);
        },
      },
    );
    const model = {
      outline: vi.fn().mockRejectedValue(new Error(privateText)),
      parseWeek: vi.fn(),
    };
    const ctx = await enabledContext(model, logger);
    const result = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send({ ...input, sheets: [{ name: '2026', cells: [[1, 1, privateText]] }] });
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: 'PARSE_FAILED', reason: 'BAD_OUTPUT' });
    expect(model.outline).toHaveBeenCalledTimes(2);
    expect(
      (
        await request(ctx.app)
          .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
          .set(auth(ctx.coachToken))
      ).body.remaining_today,
    ).toBe(3);
    expect(logs.join('')).not.toContain(privateText);
    expect(logs.join('')).not.toContain('test-placeholder');
  });
  it('rejects foreign trainees and requires a coach for every endpoint', async () => {
    const model = { outline: vi.fn().mockResolvedValue(outline), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    expect(
      (
        await request(ctx.app)
          .get(`/coach/plan-imports/status?trainee_id=${ids.otherStudent}`)
          .set(auth(ctx.coachToken))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(ctx.app)
          .post('/coach/plan-imports')
          .set(auth(ctx.coachToken))
          .send({ ...input, trainee_id: ids.otherStudent })
      ).status,
    ).toBe(404);
    for (const token of [ctx.traineeToken, ctx.otherStudentToken]) {
      expect(
        (
          await request(ctx.app)
            .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
            .set(auth(token))
        ).status,
      ).toBe(403);
      expect(
        (await request(ctx.app).post('/coach/plan-imports').set(auth(token)).send(input)).status,
      ).toBe(403);
      expect(
        (
          await request(ctx.app)
            .post(`/coach/plan-imports/${ids.exercise}/weeks`)
            .set(auth(token))
            .send({})
        ).status,
      ).toBe(403);
    }
    expect(model.outline).not.toHaveBeenCalled();
  });
  it('rejects cross-coach imports and a ninth weeks call without spending outline quota', async () => {
    const model = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn().mockResolvedValue(weekResult(0)),
    };
    const ctx = await enabledContext(model);
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const path = `/coach/plan-imports/${String(created.body.import_id)}/weeks`;
    const body = { header_cells: [], weeks: [{ index: 0, cells: input.sheets[0]?.cells }] };
    expect(
      (await request(ctx.app).post(path).set(auth(ctx.otherCoachToken)).send(body)).status,
    ).toBe(404);
    for (let i = 0; i < 8; i++)
      expect((await request(ctx.app).post(path).set(auth(ctx.coachToken)).send(body)).status).toBe(
        200,
      );
    expect((await request(ctx.app).post(path).set(auth(ctx.coachToken)).send(body)).status).toBe(
      409,
    );
    expect(model.parseWeek).toHaveBeenCalledTimes(8);
    expect(
      (
        await request(ctx.app)
          .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
          .set(auth(ctx.coachToken))
      ).body.remaining_today,
    ).toBe(2);
  });
  it('resets quota at Shanghai midnight and expires yesterday imports', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T15:59:59Z') });
    const model = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn().mockResolvedValue(weekResult(0)),
    };
    const ctx = await enabledContext(model);
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const status = () =>
      request(ctx.app)
        .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
        .set(auth(ctx.coachToken));
    expect((await status()).body.remaining_today).toBe(2);
    vi.setSystemTime(new Date('2026-10-22T16:00:00Z'));
    expect((await status()).body.remaining_today).toBe(3);
    expect(
      (
        await request(ctx.app)
          .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
          .set(auth(ctx.coachToken))
          .send({ header_cells: [], weeks: [{ index: 0, cells: input.sheets[0]?.cells }] })
      ).status,
    ).toBe(404);
    expect(model.parseWeek).not.toHaveBeenCalled();
  });
  it('rejects filename fields instead of accepting or forwarding them', async () => {
    const model = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn().mockResolvedValue(weekResult(0)),
    };
    const ctx = await enabledContext(model);
    for (const body of [
      { ...input, filename: 'private.xlsx' },
      { ...input, sheets: [{ ...input.sheets[0], filename: 'private.xlsx' }] },
    ]) {
      expect(
        (await request(ctx.app).post('/coach/plan-imports').set(auth(ctx.coachToken)).send(body))
          .status,
      ).toBe(400);
    }
    expect(model.outline).not.toHaveBeenCalled();
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    expect(model.outline.mock.calls[0]?.[0]).toEqual({ sheets: input.sheets });
    expect(
      (
        await request(ctx.app)
          .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
          .set(auth(ctx.coachToken))
          .send({
            filename: 'private.xlsx',
            header_cells: [],
            weeks: [{ index: 0, cells: input.sheets[0]?.cells }],
          })
      ).status,
    ).toBe(400);
    expect(model.parseWeek).not.toHaveBeenCalled();
  });
  it.each([
    {
      label: 'RPE digit string 6788',
      cells: ['4*8', 'rpe', '6788'],
      mode: 'rpe' as const,
      sets: 4,
      reps: '8',
      values: ['6', '7', '8', '8'],
      flags: [],
    },
    {
      label: 'RPE digit string 5677',
      cells: ['4*8', 'rpe', '5677'],
      mode: 'rpe' as const,
      sets: 4,
      reps: '8',
      values: ['5', '6', '7', '7'],
      flags: [],
    },
    {
      label: 'RPE range endpoints',
      cells: ['4*8', 'rpe8-9'],
      mode: 'rpe' as const,
      sets: 4,
      reps: '8',
      values: ['8', '8', '9', '9'],
      flags: [],
    },
    {
      label: 'broadcast weight',
      cells: ['4*8', '120'],
      mode: 'kg' as const,
      sets: 4,
      reps: '8',
      values: ['120', '120', '120', '120'],
      flags: [],
    },
    {
      label: 'absent weight',
      cells: ['4*8', '120'],
      mode: 'kg' as const,
      sets: 4,
      reps: '8',
      values: ['125', '125', '125', '125'],
      flags: ['inferred'],
    },
    {
      label: 'unreadable sets sentinel',
      cells: ['深蹲 力竭'],
      mode: 'none' as const,
      sets: 0,
      reps: '',
      values: [],
      flags: [],
    },
  ])('checks inferred evidence for $label', async ({ cells, mode, sets, reps, values, flags }) => {
    const parsed = weekResult(0);
    const exercise = parsed.days[0]?.exercises[0];
    if (!exercise) throw new Error('missing fixture exercise');
    Object.assign(exercise, { mode, sets, reps, values });
    const ctx = await enabledContext({
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn().mockResolvedValue(parsed),
    });
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const response = await request(ctx.app)
      .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
      .set(auth(ctx.coachToken))
      .send({
        header_cells: [],
        weeks: [{ index: 0, cells: cells.map((text, col) => [1, col + 1, text]) }],
      });
    expect(response.status).toBe(200);
    expect(response.body.weeks[0].days[0].exercises[0]).toEqual({ ...exercise, flags });
  });
  it('adds inferred for new values, sets or reps using only that week, and preserves model flags', async () => {
    const model: PlanImportModel = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn(({ index }: WeekInput) => {
        const result = weekResult(index);
        const exercise = result.days[0]?.exercises[0];
        if (!exercise) throw new Error('missing fixture exercise');
        if (index === 0) exercise.values = ['120', '120', '120', '120'];
        if (index === 1) {
          exercise.sets = 5;
          exercise.values = [];
        }
        if (index === 2) exercise.reps = '9+';
        if (index === 3) exercise.flags = ['inferred', 'note_fallback'];
        if (index === 4) {
          exercise.values = ['112.50', '112.50', '112.50', '112.50'];
        }
        return Promise.resolve(result);
      }),
    };
    const ctx = await enabledContext(model);
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const result = await request(ctx.app)
      .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
      .set(auth(ctx.coachToken))
      .send({
        header_cells: [[1, 1, '120 5 9']],
        weeks: Array.from({ length: 5 }, (_, index) => ({ index, cells: input.sheets[0]?.cells })),
      });
    expect(result.status).toBe(200);
    expect(result.body.weeks.map((week: WeekResult) => week.days[0]?.exercises[0]?.flags)).toEqual([
      ['inferred'],
      ['inferred'],
      ['inferred'],
      ['inferred', 'note_fallback'],
      [],
    ]);
  });
  it('parses at most four weeks at once, retries once, and isolates a failed week', async () => {
    let active = 0;
    let peak = 0;
    const attempts = new Map<number, number>();
    const model: PlanImportModel = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn(async ({ index }: WeekInput) => {
        active++;
        peak = Math.max(peak, active);
        const attempt = (attempts.get(index) ?? 0) + 1;
        attempts.set(index, attempt);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        if (index === 2 || (index === 3 && attempt === 1)) throw new Error('private cell content');
        return weekResult(index);
      }),
    };
    const ctx = await enabledContext(model);
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const result = await request(ctx.app)
      .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
      .set(auth(ctx.coachToken))
      .send({
        header_cells: [],
        weeks: Array.from({ length: 8 }, (_, index) => ({ index, cells: input.sheets[0]?.cells })),
      });
    expect(result.status).toBe(200);
    expect(result.body.weeks).toEqual(
      Array.from({ length: 8 }, (_, index) =>
        index === 2 ? { index, error: 'PARSE_FAILED', reason: 'BAD_OUTPUT' } : weekResult(index),
      ),
    );
    expect(peak).toBe(4);
    expect(attempts.get(2)).toBe(2);
    expect(attempts.get(3)).toBe(2);
    expect(
      (
        await request(ctx.app)
          .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
          .set(auth(ctx.coachToken))
      ).body.remaining_today,
    ).toBe(2);
  });
  it('counts only successful outlines and refuses a fourth success', async () => {
    const model = { outline: vi.fn().mockResolvedValue(outline), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    const status = () =>
      request(ctx.app)
        .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
        .set(auth(ctx.coachToken));
    const post = () =>
      request(ctx.app).post('/coach/plan-imports').set(auth(ctx.coachToken)).send(input);
    expect((await status()).body).toEqual({ enabled: true, daily_limit: 3, remaining_today: 3 });
    model.outline.mockResolvedValueOnce({ ...outline, weeks: [] });
    const noWeeks = await post();
    expect(noWeeks.status).toBe(422);
    expect(noWeeks.body).toEqual({ error: 'NO_TRAINING_WEEKS' });
    expect((await status()).body.remaining_today).toBe(3);
    for (let remaining = 2; remaining >= 0; remaining--) {
      const result = await post();
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ...outline, truncated_rows: 0, import_id: expect.any(String) });
      expect((await status()).body.remaining_today).toBe(remaining);
    }
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'IMPORT_DAILY_LIMIT', remaining_today: 0 });
    expect(model.outline).toHaveBeenCalledTimes(4);
  });
  it('starts without a key and disables both import steps', async () => {
    const ctx = await makeContext();
    contexts.push(ctx);
    const status = await request(ctx.app)
      .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
      .set(auth(ctx.coachToken));
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ enabled: false, daily_limit: 3, remaining_today: 0 });
    for (const path of ['/coach/plan-imports', `/coach/plan-imports/${ids.exercise}/weeks`]) {
      const response = await request(ctx.app).post(path).set(auth(ctx.coachToken)).send({});
      expect(response.status).toBe(404);
    }
  });
});
