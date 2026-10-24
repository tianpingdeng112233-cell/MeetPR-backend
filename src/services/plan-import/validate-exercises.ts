import {
  ExerciseSchema,
  SourceCellSchema,
  type Cell,
  type WeekResult,
  type WeekSkeleton,
} from './model';

export function validateExercises(week: WeekSkeleton, cells: Cell[]): WeekResult {
  // Requests contain the edited week cells, not the original outline region.
  // Use their bounds, excluding header_cells; an empty week has no valid references.
  const region = cells.reduce(
    (bounds, [row, col]) => ({
      r1: Math.min(bounds.r1, row),
      c1: Math.min(bounds.c1, col),
      r2: Math.max(bounds.r2, row),
      c2: Math.max(bounds.c2, col),
    }),
    { r1: Infinity, c1: Infinity, r2: -Infinity, c2: -Infinity },
  );
  const unreadable: WeekResult['unreadable'] = [];
  const days = week.days.map((day) => ({
    ...day,
    exercises: day.exercises.flatMap((raw) => {
      const fields =
        typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const source_cells = Array.isArray(fields.source_cells)
        ? fields.source_cells.flatMap((cell) => {
            const ref = SourceCellSchema.safeParse(cell);
            if (!ref.success) return [];
            const [row, col] = ref.data;
            return row >= region.r1 && row <= region.r2 && col >= region.c1 && col <= region.c2
              ? [ref.data]
              : [];
          })
        : [];
      const parsed = ExerciseSchema.safeParse({ ...fields, source_cells });
      if (parsed.success) return [parsed.data];
      const location = { day_index: day.day_index, weekday: day.weekday, source_cells };
      const invalidNumber = parsed.error.issues.find(
        (issue) =>
          ((issue.path[0] === 'intensity_values' || issue.path[0] === 'weight_values') &&
            typeof issue.path[1] === 'number') ||
          issue.path[0] === 'reps',
      );
      const mismatch = parsed.error.issues.find(
        (issue) =>
          issue.code === 'custom' &&
          (issue.path[0] === 'intensity_values' || issue.path[0] === 'weight_values'),
      );
      const values = mismatch ? fields[String(mismatch.path[0])] : undefined;
      if (invalidNumber) {
        const field = String(invalidNumber.path[0]);
        const entries = fields[field];
        const value: unknown = Array.isArray(entries)
          ? entries[Number(invalidNumber.path[1])]
          : entries;
        // Invalid strings can contain original cell text. Only echo numeric scalars.
        const safeValue =
          typeof value === 'number' && Number.isFinite(value)
            ? value
            : typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value)
              ? value
              : null;
        unreadable.push({
          ...location,
          reason: 'INVALID_NUMBER',
          detail: {
            track:
              field === 'intensity_values'
                ? 'intensity'
                : field === 'weight_values'
                  ? 'weight'
                  : 'reps',
            value: safeValue,
          },
        });
      } else if (mismatch && Array.isArray(values) && typeof fields.sets === 'number') {
        unreadable.push({
          ...location,
          reason: 'SETS_VALUES_MISMATCH',
          detail: {
            track: mismatch.path[0] === 'intensity_values' ? 'intensity' : 'weight',
            sets: fields.sets,
            got: values.length,
          },
        });
      } else {
        const reason = parsed.error.issues.some((issue) => issue.path[0] === 'name')
          ? 'MISSING_NAME'
          : parsed.error.issues.some((issue) => issue.path[0] === 'sets')
            ? 'MISSING_SETS'
            : 'OTHER';
        unreadable.push({ ...location, reason, detail: null });
      }
      return [];
    }),
  }));
  return { ...week, days, unreadable };
}
