import type { CompetitionStance, DeadliftStyle, LiftFamily, SquatStance } from '../db/types';

export const E1RM_POLICY = {
  maximumReps: 10,
  maximumDeadliftReps: 5,
  rollingWindowDays: 28,
  prNoiseRatio: 0.03,
  softJumpRatio: 0.1,
  hardJumpRatio: 0.18,
} as const;

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

interface CompetitionExercise {
  main_lift_family: LiftFamily | null;
  is_competition_lift: boolean;
  competition_stance: CompetitionStance | null;
}

interface CompetitionOnboarding {
  squat_stance: SquatStance | null;
  deadlift_style: DeadliftStyle | null;
}

export function resolveCompetitionFamily(
  exercise: CompetitionExercise,
  onboarding: CompetitionOnboarding,
): LiftFamily | null {
  const family = exercise.main_lift_family;
  if (family === null) return null;
  const competitionStance = exercise.competition_stance;
  if (competitionStance === null) return exercise.is_competition_lift ? family : null;
  const stance =
    family === 'squat'
      ? onboarding.squat_stance
      : family === 'deadlift'
        ? onboarding.deadlift_style
        : null;
  if (stance === null) return family;
  if (family === 'deadlift' && stance === 'both') return family;
  return competitionStance === stance ? family : null;
}

interface E1RMInput {
  family: LiftFamily | null;
  weightKg: number;
  reps: number;
  rpe: number | null;
  completed: boolean;
  failed: boolean;
  confidence: 'normal' | 'low' | null;
}

export function calculateEligibleE1RM(input: E1RMInput): number | null {
  const family = input.family;
  if (family === null || !input.completed || input.failed || input.confidence === 'low')
    return null;
  if (input.weightKg <= 0 || input.reps < 1 || input.reps > E1RM_POLICY.maximumReps) return null;
  if (family === 'deadlift' && input.reps > E1RM_POLICY.maximumDeadliftReps) return null;

  if (input.rpe === null || input.rpe < 6) {
    return input.weightKg * (1 + input.reps / 30);
  }
  if (input.rpe > 10) return null;

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
