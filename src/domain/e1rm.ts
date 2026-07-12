import type { LiftFamily } from '../db/types';

export const MAIN_LIFT_EXERCISE_IDS = {
  squat: '2f708759-821a-4d5b-9fde-32f60bc2b7f2',
  bench: '40c56af8-69d8-4a4a-a690-526ee38d081b',
  conventionalDeadlift: '4a912d5c-2248-4f3d-80ec-384f8360c315',
  sumoDeadlift: 'faa76bdb-844a-42a2-8298-ed073e9915c1',
} as const;

export const E1RM_POLICY = {
  minimumRpe: 7,
  maximumReps: 10,
  maximumDeadliftReps: 5,
  rollingWindowDays: 28,
  prNoiseRatio: 0.03,
  softJumpRatio: 0.1,
  hardJumpRatio: 0.18,
} as const;

const MAIN_LIFT_FAMILY_BY_ID: Readonly<Record<string, LiftFamily>> = {
  [MAIN_LIFT_EXERCISE_IDS.squat]: 'squat',
  [MAIN_LIFT_EXERCISE_IDS.bench]: 'bench',
  [MAIN_LIFT_EXERCISE_IDS.conventionalDeadlift]: 'deadlift',
  [MAIN_LIFT_EXERCISE_IDS.sumoDeadlift]: 'deadlift',
};

// RTS intensity table from the iOS E1RMCalculator. Rows are reps 1...10;
// columns are RPE 6.0...10.0 in 0.5 steps.
const RTS_INTENSITY = [
  [0.84, 0.86, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98, 1],
  [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92, 0.94, 0.96],
  [0.76, 0.78, 0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92],
  [0.72, 0.74, 0.76, 0.78, 0.8, 0.82, 0.84, 0.86, 0.88],
  [0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82, 0.84, 0.86],
  [0.68, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82, 0.84],
  [0.66, 0.68, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82],
  [0.64, 0.66, 0.68, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8],
  [0.62, 0.64, 0.66, 0.68, 0.7, 0.72, 0.74, 0.76, 0.78],
  [0.6, 0.62, 0.64, 0.66, 0.68, 0.7, 0.72, 0.74, 0.76],
] as const;

export function mainLiftFamily(exerciseId: string): LiftFamily | null {
  return MAIN_LIFT_FAMILY_BY_ID[exerciseId.toLowerCase()] ?? null;
}

interface E1RMInput {
  exerciseId: string;
  weightKg: number;
  reps: number;
  rpe: number | null;
  completed: boolean;
  failed: boolean;
  confidence: 'normal' | 'low' | null;
}

export function calculateEligibleE1RM(input: E1RMInput): number | null {
  const family = mainLiftFamily(input.exerciseId);
  if (family === null || !input.completed || input.failed || input.confidence === 'low')
    return null;
  if (input.weightKg <= 0 || input.reps < 1 || input.reps > E1RM_POLICY.maximumReps) return null;
  if (family === 'deadlift' && input.reps > E1RM_POLICY.maximumDeadliftReps) return null;
  if (input.rpe !== null && input.rpe < E1RM_POLICY.minimumRpe) return null;

  if (input.rpe === null) {
    return input.weightKg * (1 + input.reps / 30);
  }

  const rpePosition = (input.rpe - 6) / 0.5;
  const lower = Math.floor(rpePosition);
  const upper = Math.min(lower + 1, 8);
  const fraction = rpePosition - lower;
  const row = RTS_INTENSITY[input.reps - 1];
  const lowerIntensity = row?.[lower];
  const upperIntensity = row?.[upper];
  if (lowerIntensity === undefined || upperIntensity === undefined) return null;
  const intensity = lowerIntensity * (1 - fraction) + upperIntensity * fraction;
  return intensity > 0.5 ? input.weightKg / intensity : null;
}
