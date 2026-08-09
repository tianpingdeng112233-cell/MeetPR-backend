import type { Selectable, Updateable } from 'kysely';

import type { LoadMode, PlanSetsTable } from '../../db/types';

export const NEW_INTENSITY_FIELDS = [
  'load_mode',
  'target_pct',
  'target_rpe',
  'rir_target',
  'rpe_low',
  'rpe_high',
  'weight_low',
  'weight_high',
  'target_weight',
] as const;

const MODE_VALUE_FIELDS = [
  'target_pct',
  'target_rpe',
  'rir_target',
  'rpe_low',
  'rpe_high',
  'weight_low',
  'weight_high',
] as const;

type DecimalInput = string | number | null | undefined;

export interface IntensityInput {
  load_mode?: LoadMode | null | undefined;
  target_pct?: DecimalInput;
  target_rpe?: DecimalInput;
  rir_target?: DecimalInput;
  rpe_low?: DecimalInput;
  rpe_high?: DecimalInput;
  weight_low?: DecimalInput;
  weight_high?: DecimalInput;
  target_weight?: DecimalInput;
}

export interface IntensityState {
  load_mode: LoadMode | null;
  target_pct: string | null;
  target_rpe: string | null;
  rir_target: number | null;
  rpe_low: string | null;
  rpe_high: string | null;
  weight_low: string | null;
  weight_high: string | null;
  target_weight: string | null;
}

export interface IntensityValidationIssue {
  path: string[];
  message: string;
}

type PlanSetRow = Selectable<PlanSetsTable>;

function decimal(value: DecimalInput): string | null {
  return value == null ? null : String(value);
}

function integer(value: DecimalInput): number | null {
  return value == null ? null : Number(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function usesNewIntensityShape(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    NEW_INTENSITY_FIELDS.some((field) => hasOwn(value, field))
  );
}

export function batchUsesNewIntensityShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const days = (value as { upsert_days?: unknown }).upsert_days;
  if (!Array.isArray(days)) return false;
  return days.some((day) => {
    if (typeof day !== 'object' || day === null) return false;
    const exercises = (day as { exercises?: unknown }).exercises;
    return (
      Array.isArray(exercises) &&
      exercises.some((exercise) => {
        if (typeof exercise !== 'object' || exercise === null) return false;
        const sets = (exercise as { sets?: unknown }).sets;
        return Array.isArray(sets) && sets.some(usesNewIntensityShape);
      })
    );
  });
}

export function intensityState(input: IntensityInput): IntensityState {
  return {
    load_mode: input.load_mode ?? null,
    target_pct: decimal(input.target_pct),
    target_rpe: decimal(input.target_rpe),
    rir_target: integer(input.rir_target),
    rpe_low: decimal(input.rpe_low),
    rpe_high: decimal(input.rpe_high),
    weight_low: decimal(input.weight_low),
    weight_high: decimal(input.weight_high),
    target_weight: decimal(input.target_weight),
  };
}

function issue(path: string, message: string): IntensityValidationIssue {
  return { path: [path], message };
}

function validateHalfStep(
  state: IntensityState,
  field: 'target_pct' | 'target_rpe' | 'rpe_low' | 'rpe_high',
  minimum: number,
  maximum: number,
  issues: IntensityValidationIssue[],
): void {
  const value = state[field];
  if (value === null) return;
  const numeric = Number(value);
  if (numeric < minimum || numeric > maximum) {
    issues.push(
      issue(field, `${field} must be between ${minimum.toFixed(1)} and ${maximum.toFixed(1)}`),
    );
  }
  if (!Number.isInteger(numeric * 2)) {
    issues.push(issue(field, `${field} must use 0.5 increments`));
  }
}

function validateWeight(
  state: IntensityState,
  field: 'weight_low' | 'weight_high' | 'target_weight',
  issues: IntensityValidationIssue[],
): void {
  const value = state[field];
  if (value === null) return;
  const numeric = Number(value);
  if (numeric <= 0 || numeric >= 1000) {
    issues.push(issue(field, `${field} must be greater than 0 and less than 1000`));
  }
}

function requireField(
  state: IntensityState,
  field: keyof Omit<IntensityState, 'load_mode'>,
  issues: IntensityValidationIssue[],
): void {
  if (state[field] === null) issues.push(issue(field, `${field} is required for this load_mode`));
}

function rejectOtherModeFields(
  state: IntensityState,
  allowed: ReadonlySet<string>,
  issues: IntensityValidationIssue[],
): void {
  for (const field of MODE_VALUE_FIELDS) {
    if (!allowed.has(field) && state[field] !== null) {
      issues.push(issue(field, `${field} must be null for this load_mode`));
    }
  }
}

export function validateIntensityValues(state: IntensityState): IntensityValidationIssue[] {
  const issues: IntensityValidationIssue[] = [];
  validateHalfStep(state, 'target_pct', 20, 110, issues);
  validateHalfStep(state, 'target_rpe', 1, 10, issues);
  validateHalfStep(state, 'rpe_low', 1, 10, issues);
  validateHalfStep(state, 'rpe_high', 1, 10, issues);
  validateWeight(state, 'weight_low', issues);
  validateWeight(state, 'weight_high', issues);
  validateWeight(state, 'target_weight', issues);

  if (
    state.rir_target !== null &&
    (!Number.isInteger(state.rir_target) || state.rir_target < 0 || state.rir_target > 9)
  ) {
    issues.push(issue('rir_target', 'rir_target must be an integer between 0 and 9'));
  }
  if (
    state.rpe_low !== null &&
    state.rpe_high !== null &&
    Number(state.rpe_low) >= Number(state.rpe_high)
  ) {
    issues.push(issue('rpe_high', 'rpe_high must be greater than rpe_low'));
  }
  if (
    state.weight_low !== null &&
    state.weight_high !== null &&
    Number(state.weight_low) >= Number(state.weight_high)
  ) {
    issues.push(issue('weight_high', 'weight_high must be greater than weight_low'));
  }

  return issues;
}

export function validateIntensityState(state: IntensityState): IntensityValidationIssue[] {
  const issues = validateIntensityValues(state);

  switch (state.load_mode) {
    case null:
      requireField(state, 'target_weight', issues);
      rejectOtherModeFields(state, new Set(), issues);
      break;
    case 'pct':
      requireField(state, 'target_pct', issues);
      rejectOtherModeFields(state, new Set(['target_pct']), issues);
      break;
    case 'rpe':
      requireField(state, 'target_rpe', issues);
      rejectOtherModeFields(state, new Set(['target_rpe']), issues);
      break;
    case 'rir':
      requireField(state, 'rir_target', issues);
      rejectOtherModeFields(state, new Set(['rir_target']), issues);
      break;
    case 'rpe_range':
      requireField(state, 'rpe_low', issues);
      requireField(state, 'rpe_high', issues);
      rejectOtherModeFields(state, new Set(['rpe_low', 'rpe_high']), issues);
      break;
    case 'weight_range':
      requireField(state, 'weight_low', issues);
      requireField(state, 'weight_high', issues);
      rejectOtherModeFields(state, new Set(['weight_low', 'weight_high']), issues);
      if (state.target_weight !== null) {
        issues.push(issue('target_weight', 'target_weight must be null for weight_range'));
      }
      break;
    case 'fixed_weight':
      requireField(state, 'target_weight', issues);
      rejectOtherModeFields(state, new Set(), issues);
      break;
  }

  return issues;
}

function pctProjection(targetPct: string): number {
  const pct = Number(targetPct);
  if (pct < 60) return 5;
  if (pct < 70) return 6;
  if (pct < 80) return 7;
  if (pct < 87.5) return 8;
  if (pct <= 92.5) return 9;
  return 10;
}

function requiredDecimal(value: string | null, field: string): string {
  if (value === null) throw new Error(`validated intensity is missing ${field}`);
  return value;
}

function requiredInteger(value: number | null, field: string): number {
  if (value === null) throw new Error(`validated intensity is missing ${field}`);
  return value;
}

export function intensityWrite(
  state: IntensityState,
): Updateable<PlanSetsTable> & { intensity_mode: 'weight' | 'rpe'; target_value: string } {
  let intensityMode: 'weight' | 'rpe';
  let targetValue: string;

  if (state.target_weight !== null) {
    intensityMode = 'weight';
    targetValue = state.target_weight;
  } else {
    switch (state.load_mode) {
      case 'pct':
        intensityMode = 'rpe';
        targetValue = String(pctProjection(requiredDecimal(state.target_pct, 'target_pct')));
        break;
      case 'rpe':
        intensityMode = 'rpe';
        targetValue = requiredDecimal(state.target_rpe, 'target_rpe');
        break;
      case 'rir':
        intensityMode = 'rpe';
        targetValue = String(10 - requiredInteger(state.rir_target, 'rir_target'));
        break;
      case 'rpe_range':
        intensityMode = 'rpe';
        targetValue = requiredDecimal(state.rpe_low, 'rpe_low');
        break;
      case 'weight_range':
        intensityMode = 'weight';
        targetValue = requiredDecimal(state.weight_low, 'weight_low');
        break;
      case null:
      case 'fixed_weight':
        throw new Error('validated weight intensity is missing target_weight');
    }
  }

  return {
    ...state,
    intensity_mode: intensityMode,
    target_value: Number(targetValue).toFixed(2),
  };
}

export function mergedIntensityState(existing: PlanSetRow, patch: IntensityInput): IntensityState {
  const state = intensityState({
    load_mode: existing.load_mode,
    target_pct: existing.target_pct,
    target_rpe: existing.target_rpe,
    rir_target: existing.rir_target,
    rpe_low: existing.rpe_low,
    rpe_high: existing.rpe_high,
    weight_low: existing.weight_low,
    weight_high: existing.weight_high,
    target_weight:
      existing.target_weight ??
      (existing.load_mode === null && existing.intensity_mode === 'weight'
        ? existing.target_value
        : null),
  });

  const switchesMode = patch.load_mode !== undefined && patch.load_mode !== state.load_mode;
  if (switchesMode) {
    for (const field of MODE_VALUE_FIELDS) state[field] = null;
    if (patch.load_mode === 'weight_range') state.target_weight = null;
  }

  if (patch.load_mode !== undefined) state.load_mode = patch.load_mode;
  for (const field of [...MODE_VALUE_FIELDS, 'target_weight'] as const) {
    if (patch[field] === undefined) continue;
    if (field === 'rir_target') state.rir_target = integer(patch.rir_target);
    else state[field] = decimal(patch[field]);
  }
  return state;
}
