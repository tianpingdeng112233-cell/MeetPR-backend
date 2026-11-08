import { normalizeOrdinalWeek } from './day-cycles';
import { groundWeek } from './ground-week';
import {
  RegroupableWeekSkeletonSchema,
  WeekSkeletonSchema,
  type Cell,
  type WeekSkeleton,
} from './model';
import { validateExercises } from './validate-exercises';

// Used at both the adapter and orchestration boundaries, before ordinary
// per-exercise validation. A failed recovery retains the original BAD_OUTPUT.
export function parseWeekSkeleton(
  value: unknown,
  cells: Cell[],
  headerCells: Cell[] = [],
): WeekSkeleton {
  const normalized = normalizeOrdinalWeek(value, cells);
  const strict = WeekSkeletonSchema.safeParse(normalized);
  if (strict.success) return strict.data;

  const candidate = RegroupableWeekSkeletonSchema.safeParse(normalized);
  if (!candidate.success) throw strict.error;
  const exercises = candidate.data.days.flatMap((day) => day.exercises);

  try {
    const validated = validateExercises(candidate.data, cells);
    if (
      validated.unreadable.length > 0 ||
      validated.days.flatMap((day) => day.exercises).length !== exercises.length
    )
      throw strict.error;
    const grounded = groundWeek(validated, cells, headerCells, true);
    if (
      grounded.unreadable.length > 0 ||
      grounded.days.flatMap((day) => day.exercises).length !== exercises.length
    )
      throw strict.error;
    return WeekSkeletonSchema.parse(grounded);
  } catch {
    throw strict.error;
  }
}
