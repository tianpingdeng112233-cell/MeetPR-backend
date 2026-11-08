import type { Cell, WeekResult } from './model';

function numbers(text: string, includeDigitEvidence = false): string[] {
  // Preserve whole-number evidence and numeric equivalence (112.50 = 112.5).
  // Only cell evidence expands short digit strings, e.g. RPE 6788 = 6/7/8/8.
  return (text.match(/\d+(?:\.\d+)?|\.\d+/g) ?? []).flatMap((value) =>
    includeDigitEvidence && /^\d{2,6}$/.test(value)
      ? [String(Number(value)), ...(value.match(/\d/g) ?? [])]
      : [String(Number(value))],
  );
}

export function flagInferred(result: WeekResult, cells: Cell[]): WeekResult {
  const evidence = new Set(cells.flatMap((cell) => numbers(cell[2], true)));
  return {
    ...result,
    days: result.days.map((day) => ({
      ...day,
      exercises: day.exercises.map((exercise) => {
        const missing = [
          exercise.sets === 0 ? '' : String(exercise.sets),
          exercise.reps,
          ...exercise.intensity_values,
          ...exercise.weight_values,
        ]
          .flatMap((value) => numbers(value))
          .some((value) => !evidence.has(value));
        return {
          ...exercise,
          flags:
            missing && !exercise.flags.includes('inferred')
              ? [...exercise.flags, 'inferred' as const]
              : exercise.flags,
        };
      }),
    })),
  };
}
