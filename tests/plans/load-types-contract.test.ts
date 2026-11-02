// Socket-free companions to the HTTP seam for restricted test environments.
import { describe, expect, it } from 'vitest';
import { CreatePlanSetBodySchema } from '../../src/routes/plans/schemas';
import {
  intensityState,
  intensityWrite,
  legacyIntensityPatch,
  normalizeLegacyBodyweightSets,
  mergedIntensityState,
  validateIntensityState,
} from '../../src/routes/plans/intensity';
import { toPlanSet, type PlanSetRow } from '../../src/routes/plans/serialization';

const row = {
  id: '60000000-0000-4000-8000-000000000001',
  plan_exercise_id: '50000000-0000-4000-8000-000000000001',
  set_number: 1,
  target_reps: 5,
  target_reps_max: null,
  intensity_mode: 'rpe',
  target_value: '10.00',
  load_mode: null,
  pct_anchor: null,
  target_pct: null,
  target_rpe: null,
  rir_target: null,
  rpe_low: null,
  rpe_high: null,
  weight_low: null,
  weight_high: null,
  target_weight: null,
  set_type: 'working',
  rest_seconds: null,
  coach_note: '自重 慢下放',
  created_at: new Date('2026-10-28T00:00:00Z'),
} as PlanSetRow;

describe('spec 056 socket-free load contract', () => {
  it.each(['bodyweight', 'free_weight'] as const)(
    'accepts %s with no target or one 034 intensity',
    (load_mode) => {
      for (const fields of [{}, { target_rpe: 8.5 }, { rir_target: 0 }, { target_pct: 110 }]) {
        const parsed = CreatePlanSetBodySchema.safeParse({
          set_number: 1,
          target_reps: 5,
          set_type: 'working',
          load_mode,
          ...fields,
        });
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw parsed.error;
        expect(intensityWrite(intensityState(parsed.data))).toMatchObject({
          intensity_mode: null,
          target_value: null,
          target_weight: null,
        });
      }
    },
  );

  it.each(['bodyweight', 'free_weight'] as const)(
    'rejects invalid %s matrix and value inputs',
    (load_mode) => {
      for (const fields of [
        { target_weight: 10 },
        { rpe_low: 7 },
        { rpe_high: 8 },
        { weight_low: 10 },
        { weight_high: 20 },
        { target_rpe: 8, rir_target: 2 },
        { target_rpe: 8, target_pct: 75 },
        { rir_target: 2, target_pct: 75 },
        { target_rpe: 0.5 },
        { target_rpe: 10.5 },
        { target_rpe: 8.2 },
        { rir_target: 10 },
        { rir_target: 1.5 },
        { target_pct: 19.5 },
        { target_pct: 110.5 },
        { target_pct: 72.3 },
        { pct_anchor: 'top_set' as const },
      ]) {
        expect(validateIntensityState(intensityState({ load_mode, ...fields }))).not.toEqual([]);
      }
    },
  );

  it('keeps every legacy response field equal and adds the marker only on read', () => {
    const migrated = {
      ...row,
      load_mode: 'bodyweight' as const,
      intensity_mode: null,
      target_value: null,
      coach_note: '慢下放',
    };
    expect(toPlanSet(row)).toMatchInlineSnapshot(`
      {
        "coach_note": "自重 慢下放",
        "created_at": "2026-10-28T00:00:00.000Z",
        "id": "60000000-0000-4000-8000-000000000001",
        "intensity_mode": "rpe",
        "load_mode": null,
        "pct_anchor": null,
        "plan_exercise_id": "50000000-0000-4000-8000-000000000001",
        "rest_seconds": null,
        "rir_target": null,
        "rpe_high": null,
        "rpe_low": null,
        "set_number": 1,
        "set_type": "working",
        "target_pct": null,
        "target_reps": 5,
        "target_reps_max": null,
        "target_rpe": null,
        "target_value": "10.00",
        "target_weight": null,
        "weight_high": null,
        "weight_low": null,
      }
    `);
    expect(toPlanSet(migrated)).toStrictEqual(toPlanSet(row));
    expect(migrated.coach_note).toBe('慢下放');
    expect(toPlanSet({ ...migrated, coach_note: null }).coach_note).toBe('自重');
    expect(toPlanSet({ ...migrated, coach_note: '自重 慢下放' }).coach_note).toBe('自重 慢下放');
    expect(toPlanSet({ ...migrated, load_mode: 'free_weight' })).toMatchObject({
      intensity_mode: 'rpe',
      target_value: '10.00',
      coach_note: '慢下放',
    });
  });

  it.each(['bodyweight', 'free_weight'] as const)(
    'clears stale weight, intensity and anchor when switching to %s',
    (load_mode) => {
      const state = mergedIntensityState(
        { ...row, load_mode: 'pct', target_pct: '80', pct_anchor: 'top_set', target_weight: '100' },
        { load_mode, target_rpe: 8 },
      );
      expect(state).toMatchObject({
        load_mode,
        target_rpe: '8',
        target_weight: null,
        target_pct: null,
        pct_anchor: null,
      });
      expect(validateIntensityState(state)).toEqual([]);
    },
  );
});

describe('spec 056 socket-free legacy writes', () => {
  it.each([undefined, null])(
    'normalizes marker-only and mixed notes with load_mode=%s',
    (load_mode) => {
      for (const [coach_note, expected] of [
        ['自重', null],
        ['BODYWEIGHT', null],
        ['自重 慢下放', ' 慢下放'],
        ['bodyweight 自重 停顿', ' 自重 停顿'],
      ]) {
        const parsed = CreatePlanSetBodySchema.safeParse({
          set_number: 1,
          target_reps: 5,
          set_type: 'working',
          intensity_mode: 'rpe',
          target_value: 10,
          load_mode,
          coach_note,
        });
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw parsed.error;
        expect(parsed.data.load_mode).toBe(load_mode);
        expect(normalizeLegacyBodyweightSets([parsed.data])[0]).toMatchObject({
          load_mode: 'bodyweight',
          coach_note: expected,
        });
      }
    },
  );
});

describe('spec 056 legacy patch compatibility', () => {
  it.each([undefined, null])(
    'exits bodyweight when the old client writes ordinary intensity with load_mode=%s',
    (load_mode) => {
      for (const [intensity_mode, target_value] of [
        ['weight', '50.00'],
        ['rpe', '8.00'],
      ] as const) {
        const patch = legacyIntensityPatch(
          {
            ...row,
            load_mode: 'bodyweight',
            intensity_mode: null,
            target_value: null,
            target_rpe: '7',
          },
          { load_mode, intensity_mode, target_value: Number(target_value), coach_note: null },
        );
        expect(patch).toMatchObject({
          load_mode: null,
          target_rpe: null,
          intensity_mode,
          target_value,
          coach_note: null,
        });
      }
    },
  );
});

describe('D1 legacy schema safety', () => {
  it.each([undefined, null])(
    'defers legacy conversion until all siblings are known (load_mode=%s)',
    (load_mode) => {
      const input = {
        set_number: 1,
        target_reps: 5,
        set_type: 'working',
        load_mode,
        intensity_mode: 'rpe',
        target_value: '10.00',
        coach_note: '自重  自重热身后加重  ',
      };
      expect(CreatePlanSetBodySchema.parse(input)).toEqual(input);
    },
  );
});

describe('D1 legacy row predicate', () => {
  const legacy = {
    load_mode: null,
    intensity_mode: 'rpe' as const,
    target_value: '10.00',
    coach_note: '自重',
  };
  it('converts all marked RPE-10 sets and removes only one standalone token', () => {
    const sets = [legacy, { ...legacy, coach_note: 'BODYWEIGHT  自重热身后加重  ' }];
    expect(normalizeLegacyBodyweightSets(sets)).toEqual([
      { ...legacy, load_mode: 'bodyweight', coach_note: null },
      { ...legacy, load_mode: 'bodyweight', coach_note: '  自重热身后加重  ' },
    ]);
    expect(sets[1]?.coach_note).toBe('BODYWEIGHT  自重热身后加重  ');
  });
  it.each([
    {
      ...legacy,
      intensity_mode: 'weight' as const,
      target_value: '135.00',
      coach_note: '自重热身后加重',
    },
    { ...legacy, target_value: '8.00' },
    { ...legacy, coach_note: null },
    { ...legacy, coach_note: '自重热身后加重' },
    { ...legacy, load_mode: 'rpe' as const },
    { ...legacy, load_mode: 'bodyweight' as const },
  ])('preserves every set when a sibling is not exactly legacy bodyweight: %j', (sibling) => {
    const sets = [legacy, sibling];
    expect(normalizeLegacyBodyweightSets(sets)).toEqual(sets);
  });
});

describe('D1 canonical legacy roundtrip', () => {
  for (const load_mode of ['bodyweight', 'free_weight'] as const) {
    it.each([undefined, null])(
      `preserves ${load_mode} prescription when old projection is saved (load_mode=%s)`,
      (legacyMode) => {
        for (const target of [{ target_rpe: '7' }, { rir_target: 2 }, { target_pct: '75' }]) {
          const existing = {
            ...row,
            load_mode,
            intensity_mode: null,
            target_value: null,
            coach_note: null,
            ...target,
          };
          const projected = toPlanSet(existing);
          const patch = legacyIntensityPatch(existing, {
            load_mode: legacyMode,
            intensity_mode: projected.intensity_mode,
            target_value: projected.target_value,
            coach_note: projected.coach_note,
          });
          expect(patch).not.toBeNull();
          const saved = { ...existing, ...patch } as PlanSetRow;
          expect(saved).toEqual(existing);
          expect(normalizeLegacyBodyweightSets([saved, existing])).toEqual([existing, existing]);
        }
      },
    );
  }
});

describe('D1 canonical free-text note', () => {
  it('preserves a free-weight projection even when its note contains a standalone bodyweight word', () => {
    const existing = {
      ...row,
      load_mode: 'free_weight' as const,
      intensity_mode: null,
      target_value: null,
      target_rpe: '7',
      coach_note: '先 自重 热身',
    };
    const projected = toPlanSet(existing);
    const patch = legacyIntensityPatch(existing, {
      intensity_mode: projected.intensity_mode,
      target_value: projected.target_value,
      coach_note: projected.coach_note,
    });
    const saved = { ...existing, ...patch };
    expect(saved).toEqual(existing);
    expect(normalizeLegacyBodyweightSets([saved])).toEqual([existing]);
  });
});
