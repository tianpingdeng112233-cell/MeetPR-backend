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
  unreadable: [],
  days: [
    {
      weekday: 0,
      day_index: 1,
      rest: false,
      exercises: [
        {
          source_cells: [],
          unparsed: [],
          name: '深蹲',
          sets: 4,
          reps: '8',
          intensity_kind: null,
          intensity_values: [],
          weight_values: ['112.5', '112.5', '112.5', '112.5'],
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
  it.each([
    {
      label: 'empty reps with unparsed reps',
      unparsed: [{ field: 'reps', text: '力竭' }],
      expected: [{ field: 'reps', text: '力竭' }],
    },
    {
      label: 'unknown field dropped alongside valid reps',
      unparsed: [
        { field: 'sets', text: 'PRIVATE_UNKNOWN_CELL' },
        { field: 'reps', text: '力竭' },
      ],
      expected: [{ field: 'reps', text: '力竭' }],
    },
    { label: 'missing unparsed defaults to empty', unparsed: undefined, expected: [] },
    {
      label: '40-character text accepted',
      unparsed: [{ field: 'weight', text: '文'.repeat(40) }],
      expected: [{ field: 'weight', text: '文'.repeat(40) }],
    },
    { label: 'empty text rejected', unparsed: [{ field: 'reps', text: '' }], expected: null },
    { label: 'blank text rejected', unparsed: [{ field: 'reps', text: '  ' }], expected: null },
    {
      label: '41-character text rejected',
      unparsed: [{ field: 'reps', text: '文'.repeat(41) }],
      expected: null,
    },
  ])('validates unparsed: $label', async ({ unparsed, expected }) => {
    const parsed = weekResult(0);
    const exercise = parsed.days[0]?.exercises[0];
    if (!exercise) throw new Error('Missing week fixture');
    Object.assign(exercise, { reps: '', unparsed, note: '力竭' });
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
      .send({ header_cells: [], weeks: [{ index: 0, cells: [[1, 1, '深蹲 4组 力竭 112.5']] }] });
    expect(response.status).toBe(200);
    const week = response.body.weeks[0];
    if (expected === null) {
      expect(week.days[0].exercises).toEqual([]);
      expect(week.unreadable).toEqual([
        { day_index: 1, weekday: 0, source_cells: [], reason: 'OTHER', detail: null },
      ]);
    } else {
      expect(week.days[0].exercises).toEqual([{ ...exercise, unparsed: expected }]);
      expect(week.unreadable).toEqual([]);
    }
    expect(response.text).not.toContain('PRIVATE_UNKNOWN_CELL');
  });
  it('returns trimmed unparsed text per field without logging it', async () => {
    const parsed = weekResult(0);
    const exercise = parsed.days[0]?.exercises[0];
    if (!exercise) throw new Error('Missing week fixture');
    Object.assign(exercise, {
      unparsed: [
        { field: 'reps', text: ' 力竭 ' },
        { field: 'intensity', text: '60%top' },
        { field: 'weight', text: '周二减7.5' },
      ],
      note: '力竭；60%top；周二减7.5',
      flags: ['note_fallback'],
    });
    const logs: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line) => logs.push(line) });
    const ctx = await enabledContext(
      {
        outline: vi.fn().mockResolvedValue(outline),
        parseWeek: vi.fn().mockResolvedValue(parsed),
      },
      logger,
    );
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const response = await request(ctx.app)
      .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
      .set(auth(ctx.coachToken))
      .send({
        header_cells: [],
        weeks: [{ index: 0, cells: [[1, 1, '深蹲 4×8 112.5 力竭 60%top 周二减7.5']] }],
      });
    expect(response.status).toBe(200);
    expect(response.body.weeks[0].days[0].exercises[0]).toMatchObject({
      unparsed: [
        { field: 'reps', text: '力竭' },
        { field: 'intensity', text: '60%top' },
        { field: 'weight', text: '周二减7.5' },
      ],
      note: '力竭；60%top；周二减7.5',
      flags: ['note_fallback'],
    });
    expect(logs.join('')).not.toMatch(/力竭|60%top|周二减7.5/);
  });
  it.each([
    {
      label: 'single weight for three sets',
      cells: '深蹲 3×8 120kg',
      sets: 3,
      intensity_values: [],
      weight_values: ['120'],
      expectedIntensity: [],
      expectedWeight: ['120', '120', '120'],
      unreadable: [],
    },
    {
      label: 'single intensity for four sets',
      cells: '深蹲 4×8 RPE 6',
      sets: 4,
      intensity_values: ['6'],
      weight_values: [],
      expectedIntensity: ['6', '6', '6', '6'],
      expectedWeight: [],
      unreadable: [],
    },
    {
      label: 'two weights for three sets',
      cells: '深蹲 3×8 120/125kg',
      sets: 3,
      intensity_values: [],
      weight_values: ['120', '125'],
      expectedIntensity: [],
      expectedWeight: [],
      unreadable: [
        {
          day_index: 1,
          weekday: 0,
          source_cells: [],
          reason: 'SETS_VALUES_MISMATCH',
          detail: { track: 'weight', sets: 3, got: 2 },
        },
      ],
    },
  ])('normalizes written values: $label', async (fixture) => {
    const parsed = weekResult(0);
    const day = parsed.days[0];
    const original = day?.exercises[0];
    if (!day || !original) throw new Error('Missing week fixture');
    const exercise = {
      ...original,
      sets: fixture.sets,
      intensity_kind: fixture.intensity_values.length ? 'rpe' : null,
      intensity_values: fixture.intensity_values,
      weight_values: fixture.weight_values,
    };
    const model = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi
        .fn()
        .mockResolvedValue({ ...parsed, days: [{ ...day, exercises: [exercise] }] }),
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
        weeks: [{ index: 0, cells: [[1, 1, fixture.cells]] }],
      });
    expect(response.status).toBe(200);
    expect(response.body.weeks).toEqual([
      {
        ...parsed,
        days: [
          {
            ...day,
            exercises: fixture.unreadable.length
              ? []
              : [
                  {
                    ...exercise,
                    intensity_values: fixture.expectedIntensity,
                    weight_values: fixture.expectedWeight,
                    flags: [],
                  },
                ],
          },
        ],
        unreadable: fixture.unreadable,
      },
    ]);
    expect(model.parseWeek).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('drops out-of-region source cells for unreadable=%s', async (broken) => {
    const parsed = weekResult(0);
    const day = parsed.days[0];
    const original = day?.exercises[0];
    if (!day || !original) throw new Error('Missing week fixture');
    const exercise = {
      ...original,
      source_cells: [
        [2, 2],
        [4, 4],
        [3, 3],
        [1, 2],
        [5, 2],
        [2, 1],
        [2, 5],
        [0, 2],
        [2.5, 2],
        ['2', 2],
        [2, 2, 'PRIVATE_CELL_TEXT'],
      ],
      ...(broken ? { intensity_values: ['6', '6'] } : {}),
    };
    const model = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi
        .fn()
        .mockResolvedValue({ ...parsed, days: [{ ...day, exercises: [exercise] }] }),
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
        header_cells: [
          [1, 2, 'RPE'],
          [9, 9, 'header'],
        ],
        weeks: [
          {
            index: 0,
            cells: [
              [2, 2, '深蹲 4×8 112.5'],
              [4, 4, '6'],
            ],
          },
        ],
      });
    const source_cells = [
      [2, 2],
      [4, 4],
      [3, 3],
    ];
    expect(response.body.weeks).toEqual([
      {
        ...parsed,
        days: [{ ...day, exercises: broken ? [] : [{ ...exercise, source_cells }] }],
        unreadable: broken
          ? [
              {
                day_index: 1,
                weekday: 0,
                source_cells,
                reason: 'SETS_VALUES_MISMATCH',
                detail: { track: 'intensity', sets: 4, got: 2 },
              },
            ]
          : [],
      },
    ]);
    expect(model.parseWeek).toHaveBeenCalledTimes(1);
  });
  it.each([
    { fields: { name: undefined }, reason: 'MISSING_NAME' },
    { fields: { name: '   ' }, reason: 'MISSING_NAME' },
    { fields: { sets: undefined }, reason: 'MISSING_SETS' },
    { fields: { family_guess: 'PRIVATE_CELL_TEXT' }, reason: 'OTHER' },
  ])('locates $reason without leaking the failed exercise', async ({ fields, reason }) => {
    const parsed = weekResult(0);
    const day = parsed.days[0];
    if (!day) throw new Error('Missing week fixture');
    const model = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn().mockResolvedValue({
        ...parsed,
        days: [
          {
            ...day,
            weekday: null,
            exercises: [
              {
                ...day.exercises[0],
                ...fields,
                note: 'PRIVATE_CELL_TEXT',
                source_cells: [[1, 1]],
              },
            ],
          },
        ],
      }),
    };
    const ctx = await enabledContext(model);
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const response = await request(ctx.app)
      .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
      .set(auth(ctx.coachToken))
      .send({ header_cells: [], weeks: [{ index: 0, cells: input.sheets[0]?.cells }] });
    expect(response.body.weeks).toEqual([
      {
        ...parsed,
        days: [{ ...day, weekday: null, exercises: [] }],
        unreadable: [{ day_index: 1, weekday: null, source_cells: [[1, 1]], reason, detail: null }],
      },
    ]);
    expect(response.text).not.toContain('PRIVATE_CELL_TEXT');
    expect(model.parseWeek).toHaveBeenCalledTimes(1);
  });
  it.each(['fake model', 'HTTP adapter'])(
    'keeps readable exercises and locates a sets/intensity mismatch without retrying via %s',
    async (boundary) => {
      const parsed = weekResult(0);
      const day = parsed.days[0];
      const original = day?.exercises[0];
      if (!day || !original) throw new Error('Missing week fixture');
      const readable = { ...original, source_cells: [[2, 1]] };
      const broken = {
        ...readable,
        intensity_kind: 'rpe',
        intensity_values: ['6', '7', '8'],
        source_cells: [
          [3, 1],
          [3, 4],
        ],
      };
      const output = {
        ...parsed,
        days: [{ ...day, exercises: [readable, broken, readable] }],
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() =>
          Promise.resolve(
            Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }),
          ),
        );
      const adapter = createDeepSeekPlanImportModel({ apiKey: 'test-placeholder', fetch });
      const model = {
        outline: vi.fn().mockResolvedValue(outline),
        parseWeek:
          boundary === 'HTTP adapter'
            ? vi.fn(adapter.parseWeek)
            : vi.fn().mockResolvedValue(output),
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
          weeks: [
            {
              index: 0,
              cells: [
                [2, 1, '深蹲 4×8 112.5'],
                [3, 1, '卧推 4×8'],
                [3, 4, '6/7/8'],
              ],
            },
          ],
        });
      expect(response.status).toBe(200);
      expect(response.body.weeks).toEqual([
        {
          ...parsed,
          days: [{ ...day, exercises: [readable, readable] }],
          unreadable: [
            {
              day_index: 1,
              weekday: 0,
              source_cells: [
                [3, 1],
                [3, 4],
              ],
              reason: 'SETS_VALUES_MISMATCH',
              detail: { track: 'intensity', sets: 4, got: 3 },
            },
          ],
        },
      ]);
      expect(model.parseWeek).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(boundary === 'HTTP adapter' ? 1 : 0);
    },
  );
  it('drops date-only weeks and renumbers the remaining training weeks', async () => {
    const weeks = [0, 1, 2, 3].map((index) => ({
      index,
      label: `W${String(index + 1)}`,
      start_date: null,
      training_days: 5,
      region: { r1: index * 3 + 1, c1: 2, r2: index * 3 + 3, c2: 4 },
    }));
    const model = { outline: vi.fn().mockResolvedValue({ ...outline, weeks }), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    const response = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send({
        ...input,
        sheets: [
          {
            name: '2026',
            cells: [
              [1, 2, '2026-01-05'],
              [2, 3, '休息'],
              [3, 4, '112.5'],
              [4, 2, '卧推'],
              [7, 2, '1/19'],
              [7, 3, '星期一'],
              [8, 2, '休息'],
              [7, 1, '区域外动作'],
              [8, 5, '区域外动作'],
              [12, 4, '深蹲 4×8'],
            ],
          },
          {
            name: 'Other',
            cells: [
              [1, 2, '其他页的动作'],
              [7, 2, '其他页的动作'],
            ],
          },
        ],
      });
    expect(response.status).toBe(200);
    expect(response.body.weeks).toEqual([
      { ...weeks[1], index: 0 },
      { ...weeks[3], index: 1 },
    ]);
    expect(await ctx.db.selectFrom('plan_import_runs').selectAll().execute()).toHaveLength(1);
  });
  it('rejects outlines containing only calendar labels, rest and numbers without a quota row', async () => {
    const model = { outline: vi.fn().mockResolvedValue(outline), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    const labels = [
      '2026-01-05',
      '46027',
      '1/5',
      '01/05',
      '周一',
      '周日',
      '星期天',
      '星期三',
      'Mon',
      'Tuesday',
      'Wed.',
      'Thursday',
      'Fri',
      'Saturday',
      'Sun',
      'Day1',
      'Day 2',
      'D3',
      '第4天',
      '休息',
      '112.5',
      '-3',
      '+2',
      '0',
    ];
    for (const label of labels) {
      const response = await request(ctx.app)
        .post('/coach/plan-imports')
        .set(auth(ctx.coachToken))
        .send({ ...input, sheets: [{ name: '2026', cells: [[1, 1, label]] }] });
      expect(response.status, label).toBe(422);
      expect(response.body).toEqual({ error: 'NO_TRAINING_WEEKS' });
    }
    expect(model.outline).toHaveBeenCalledTimes(labels.length);
    expect(await ctx.db.selectFrom('plan_import_runs').selectAll().execute()).toEqual([]);
    const status = await request(ctx.app)
      .get(`/coach/plan-imports/status?trainee_id=${ids.trainee}`)
      .set(auth(ctx.coachToken));
    expect(status.body.remaining_today).toBe(3);
  });
  it.each([
    { layout: 'horizontal', reported: 5, expected: 2 },
    { layout: 'vertical', reported: 5, expected: 2 },
    { layout: 'horizontal', reported: 1, expected: 1 },
    { layout: 'uncovered', reported: 5, expected: 5 },
  ])(
    'bounds impossible training_days for $layout blocks ($reported -> $expected)',
    async ({ layout, reported, expected }) => {
      const cells: [number, number, string][] = [
        [1, 1, 'Day1'],
        [1, 3, 'Day2'],
        [1, 5, 'Day3'],
        [2, 1, '深蹲'],
        [2, 3, '卧推'],
        [2, 5, '休息'],
      ];
      if (layout === 'vertical') {
        for (const cell of cells) [cell[0], cell[1]] = [cell[1], cell[0]];
      }
      if (layout === 'uncovered') {
        for (const cell of cells) cell[0] += 1;
        cells.push([1, 1, '未归入日块的硬拉']);
      }
      const week = {
        index: 0,
        label: 'W1',
        start_date: null,
        training_days: reported,
        region: { r1: 1, c1: 1, r2: 6, c2: 6 },
      };
      const ctx = await enabledContext({
        outline: vi.fn().mockResolvedValue({ ...outline, weeks: [week] }),
        parseWeek: vi.fn(),
      });
      const response = await request(ctx.app)
        .post('/coach/plan-imports')
        .set(auth(ctx.coachToken))
        .send({ ...input, sheets: [{ name: '2026', cells }] });
      expect(response.status).toBe(200);
      expect(response.body.weeks).toEqual([{ ...week, training_days: expected }]);
    },
  );
  it('returns a day-only week in table order without inferring simplified names', async () => {
    const day = weekResult(0).days[0];
    const exercise = day?.exercises[0];
    const firstWeek = outline.weeks[0];
    if (!day || !exercise || !firstWeek) throw new Error('Missing week fixture');
    const parsed = {
      index: 0,
      start_date: null,
      unreadable: [],
      days: [1, 2, 3, 4].map((day_index) => ({
        ...day,
        weekday: null,
        day_index,
        exercises: [{ ...exercise, name: '杠铃深蹲' }],
      })),
    };
    const dayOutline = {
      ...outline,
      weeks: [{ ...firstWeek, training_days: 4, region: { r1: 1, c1: 1, r2: 8, c2: 2 } }],
    };
    const cells = [1, 2, 3, 4].flatMap((index) => [
      [index * 2 - 1, 1, `Day${String(index)}`],
      [index * 2, 2, '槓鈴深蹲 4×8 112.5'],
    ]);
    const ctx = await enabledContext({
      outline: vi.fn().mockResolvedValue(dayOutline),
      parseWeek: vi.fn().mockResolvedValue(parsed),
    });
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send({ ...input, sheets: [{ name: '2026', cells }] });
    expect(created.status).toBe(200);
    expect(created.body.weeks).toEqual(dayOutline.weeks);
    const response = await request(ctx.app)
      .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
      .set(auth(ctx.coachToken))
      .send({ weeks: [{ index: 0, cells }], header_cells: [] });
    expect(response.status).toBe(200);
    expect(response.body.weeks).toEqual([parsed]);
  });
  it('rejects mixed weekdays and invalid day order with week BAD_OUTPUT', async () => {
    const firstDay = { weekday: 0, day_index: 1, rest: true, exercises: [] };
    const secondDay = { weekday: 2, day_index: 2, rest: true, exercises: [] };
    const parsed = {
      index: 0,
      start_date: null,
      unreadable: [],
      days: [firstDay, secondDay],
    };
    const parseWeek = vi.fn().mockResolvedValue(parsed);
    const ctx = await enabledContext({ outline: vi.fn().mockResolvedValue(outline), parseWeek });
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const sendWeek = () =>
      request(ctx.app)
        .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
        .set(auth(ctx.coachToken))
        .send({ weeks: [{ index: 0, cells: [[1, 1, '周一、周三休息']] }], header_cells: [] });
    expect((await sendWeek()).body.weeks).toEqual([parsed]);
    for (const days of [
      [{ ...firstDay, weekday: null }, secondDay],
      [firstDay, { ...secondDay, weekday: 0 }],
      [firstDay, { ...secondDay, day_index: 1 }],
      [
        { ...firstDay, day_index: 2 },
        { ...secondDay, day_index: 1 },
      ],
      [{ ...firstDay, day_index: 0 }, secondDay],
    ]) {
      parseWeek.mockClear().mockResolvedValue({ ...parsed, days });
      const response = await sendWeek();
      expect(response.status).toBe(200);
      expect(response.body.weeks).toEqual([
        { index: 0, error: 'PARSE_FAILED', reason: 'BAD_OUTPUT' },
      ]);
      expect(parseWeek).toHaveBeenCalledTimes(2);
    }
  });
  it.each([
    { kind: 'rpe', value: '6', cells: '深蹲 1×8 RPE 6 227.5kg', flags: [] },
    { kind: 'rir', value: '2', cells: '深蹲 1×8 RIR 2 227.5kg', flags: [] },
    { kind: 'pct', value: '75', cells: '深蹲 1×8 75% 227.5kg', flags: [] },
    { kind: 'rpe', value: '6', cells: '深蹲 1×8 RPE 6', flags: ['inferred'] },
    { kind: 'rpe', value: '6.5', cells: '深蹲 1×8 227.5kg', flags: ['inferred'] },
  ])(
    'returns both tracks with evidence flags for $cells / $value',
    async ({ kind, value, cells, flags }) => {
      const result = weekResult(0);
      const exercise = {
        source_cells: [],
        unparsed: [],
        name: '深蹲',
        sets: 1,
        reps: '8',
        intensity_kind: kind,
        intensity_values: [value],
        weight_values: ['227.5'],
        note: '',
        family_guess: 'squat',
        flags: [],
      };
      const parsed = {
        ...result,
        days: [{ weekday: 0, day_index: 1, rest: false, exercises: [exercise] }],
      };
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
        .send({ weeks: [{ index: 0, cells: [[1, 1, cells]] }], header_cells: [] });
      expect(response.status).toBe(200);
      expect(response.body.weeks).toEqual([
        {
          ...parsed,
          days: [{ weekday: 0, day_index: 1, rest: false, exercises: [{ ...exercise, flags }] }],
        },
      ]);
    },
  );
  it.each([
    {
      field: 'intensity_values',
      values: ['6', '6'],
      reason: 'SETS_VALUES_MISMATCH',
      detail: { track: 'intensity', sets: 1, got: 2 },
    },
    {
      field: 'weight_values',
      values: ['227.5', '227.5'],
      reason: 'SETS_VALUES_MISMATCH',
      detail: { track: 'weight', sets: 1, got: 2 },
    },
    {
      field: 'intensity_values',
      values: ['<=6'],
      reason: 'INVALID_NUMBER',
      detail: { track: 'intensity', value: null },
    },
    {
      field: 'intensity_values',
      values: ['8-9'],
      reason: 'INVALID_NUMBER',
      detail: { track: 'intensity', value: null },
    },
    {
      field: 'weight_values',
      values: ['-5'],
      reason: 'INVALID_NUMBER',
      detail: { track: 'weight', value: '-5' },
    },
    {
      field: 'weight_values',
      values: ['PRIVATE_CELL_TEXT'],
      reason: 'INVALID_NUMBER',
      detail: { track: 'weight', value: null },
    },
  ])('isolates malformed $field: $values as $reason', async ({ field, values, reason, detail }) => {
    const exercise = {
      unparsed: [],
      name: '深蹲',
      sets: 1,
      reps: '8',
      intensity_kind: 'rpe',
      intensity_values: ['6'],
      weight_values: ['227.5'],
      note: '',
      family_guess: 'squat',
      flags: [],
      source_cells: [[1, 1]],
    };
    const parsed = {
      index: 0,
      start_date: null,
      days: [{ weekday: 0, day_index: 1, rest: false, exercises: [exercise] }],
      unreadable: [],
    };
    const parseWeek = vi.fn().mockResolvedValue(parsed);
    const ctx = await enabledContext({ outline: vi.fn().mockResolvedValue(outline), parseWeek });
    const created = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send(input);
    const sendWeek = () =>
      request(ctx.app)
        .post(`/coach/plan-imports/${String(created.body.import_id)}/weeks`)
        .set(auth(ctx.coachToken))
        .send({
          weeks: [{ index: 0, cells: [[1, 1, '深蹲 1×8 RPE 6 227.5kg']] }],
          header_cells: [],
        });
    expect((await sendWeek()).body.weeks).toEqual([parsed]);
    parseWeek.mockResolvedValue({
      ...parsed,
      days: [
        { weekday: 0, day_index: 1, rest: false, exercises: [{ ...exercise, [field]: values }] },
      ],
    });
    const response = await sendWeek();
    expect(response.status).toBe(200);
    expect(response.body.weeks).toEqual([
      {
        ...parsed,
        days: [{ ...parsed.days[0], exercises: [] }],
        unreadable: [{ day_index: 1, weekday: 0, source_cells: [[1, 1]], reason, detail }],
      },
    ]);
    expect(response.text).not.toContain('PRIVATE_CELL_TEXT');
    expect(parseWeek).toHaveBeenCalledTimes(2);
  });
  it('ignores empty sheets and sends only the content sheet to the model', async () => {
    const model = { outline: vi.fn().mockResolvedValue(outline), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    const response = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send({
        ...input,
        sheets: [
          { name: 'Empty before', cells: [] },
          ...input.sheets,
          { name: 'Empty after', cells: [] },
        ],
      });
    expect(response.status).toBe(200);
    expect(response.body.weeks).toEqual(outline.weeks);
    expect(model.outline).toHaveBeenCalledTimes(1);
    expect(model.outline.mock.calls[0]?.[0]).toEqual({ sheets: input.sheets });
  });
  it('rejects all-empty sheets without calling the model or creating a quota row', async () => {
    const model = { outline: vi.fn().mockResolvedValue(outline), parseWeek: vi.fn() };
    const ctx = await enabledContext(model);
    const response = await request(ctx.app)
      .post('/coach/plan-imports')
      .set(auth(ctx.coachToken))
      .send({
        ...input,
        sheets: [
          { name: 'Empty one', cells: [] },
          { name: 'Empty two', cells: [] },
        ],
      });
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: 'NO_TRAINING_WEEKS' });
    expect(model.outline).not.toHaveBeenCalled();
    expect(await ctx.db.selectFrom('plan_import_runs').selectAll().execute()).toEqual([]);
  });
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
      intensity_kind: 'rpe' as const,
      weight_values: [],
      sets: 4,
      reps: '8',
      intensity_values: ['6', '7', '8', '8'],
      flags: [],
    },
    {
      label: 'RPE digit string 5677',
      cells: ['4*8', 'rpe', '5677'],
      intensity_kind: 'rpe' as const,
      weight_values: [],
      sets: 4,
      reps: '8',
      intensity_values: ['5', '6', '7', '7'],
      flags: [],
    },
    {
      label: 'RPE range endpoints',
      cells: ['4*8', 'rpe8-9'],
      intensity_kind: 'rpe' as const,
      weight_values: [],
      sets: 4,
      reps: '8',
      intensity_values: ['8', '8', '9', '9'],
      flags: [],
    },
    {
      label: 'broadcast weight',
      cells: ['4*8', '120'],
      intensity_kind: null,
      intensity_values: [],
      sets: 4,
      reps: '8',
      weight_values: ['120', '120', '120', '120'],
      flags: [],
    },
    {
      label: 'absent weight',
      cells: ['4*8', '120'],
      intensity_kind: null,
      intensity_values: [],
      sets: 4,
      reps: '8',
      weight_values: ['125', '125', '125', '125'],
      flags: ['inferred'],
    },
    {
      label: 'unreadable sets sentinel',
      cells: ['深蹲 力竭'],
      intensity_kind: null,
      weight_values: [],
      sets: 0,
      reps: '',
      intensity_values: [],
      flags: [],
    },
  ])(
    'checks inferred evidence for $label',
    async ({ cells, intensity_kind, sets, reps, intensity_values, weight_values, flags }) => {
      const parsed = weekResult(0);
      const exercise = parsed.days[0]?.exercises[0];
      if (!exercise) throw new Error('missing fixture exercise');
      Object.assign(exercise, { intensity_kind, sets, reps, intensity_values, weight_values });
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
    },
  );
  it('adds inferred for new values, sets or reps using only that week, and preserves model flags', async () => {
    const model: PlanImportModel = {
      outline: vi.fn().mockResolvedValue(outline),
      parseWeek: vi.fn(({ index }: WeekInput) => {
        const result = weekResult(index);
        const exercise = result.days[0]?.exercises[0];
        if (!exercise) throw new Error('missing fixture exercise');
        if (index === 0) exercise.weight_values = ['120', '120', '120', '120'];
        if (index === 1) {
          exercise.sets = 5;
          exercise.weight_values = [];
        }
        if (index === 2) exercise.reps = '9+';
        if (index === 3) exercise.flags = ['inferred', 'note_fallback'];
        if (index === 4) {
          exercise.weight_values = ['112.50', '112.50', '112.50', '112.50'];
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
