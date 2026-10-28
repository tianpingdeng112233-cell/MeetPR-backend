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
      const normalized: Record<string, unknown> = { ...fields, source_cells };
      const shape = ExerciseSchema.innerType().shape;
      const sets = shape.sets.safeParse(fields.sets);
      if (sets.success && sets.data > 1) {
        for (const field of ['intensity_values', 'weight_values'] as const) {
          const values = fields[field];
          if (!Array.isArray(values) || values.length !== 1) continue;
          const value = shape[field].element.safeParse(values[0]);
          if (value.success) {
            // Repeating a written value is normal; inferred evidence is checked separately.
            normalized[field] = Array.from({ length: sets.data }, () => value.data);
          }
        }
      }
      const location = { day_index: day.day_index, weekday: day.weekday, source_cells };
      const name = shape.name.safeParse(fields.name);
      if (
        sets.success &&
        sets.data === 0 &&
        name.success &&
        /热身|激活|拉伸|warm/i.test(name.data)
      ) {
        unreadable.push({ ...location, reason: 'MISSING_SETS', detail: null });
        return [];
      }
      if (
        sets.success &&
        sets.data === 0 &&
        (fields.unparsed === undefined ||
          (Array.isArray(fields.unparsed) && fields.unparsed.length === 0)) &&
        !cells.some(
          ([row, col, text]) =>
            /\d/.test(text) && source_cells.some(([r, c]) => r === row && c === col),
        )
      )
        return [];
      const parsed = ExerciseSchema.safeParse(normalized);
      if (parsed.success) {
        const exercise = parsed.data;
        if (
          exercise.sets === 0 &&
          exercise.reps === '' &&
          exercise.intensity_values.length === 0 &&
          exercise.weight_values.length === 0 &&
          exercise.unparsed.length === 0
        ) {
          unreadable.push({ ...location, reason: 'MISSING_SETS', detail: null });
          return [];
        }
        return [exercise];
      }
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
        const sourceText =
          typeof value === 'string'
            ? cells.find(
                ([row, col, text]) =>
                  text === value.trim() && source_cells.some(([r, c]) => r === row && c === col),
              )?.[2]
            : undefined;
        if (field !== 'reps' && sourceText) {
          unreadable.push({
            ...location,
            reason: 'INVALID_NUMBER',
            detail: {
              track: field === 'intensity_values' ? 'intensity' : 'weight',
              value: sourceText,
            },
          });
        } else {
          unreadable.push({ ...location, reason: 'OTHER', detail: null });
        }
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
