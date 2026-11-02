import { type PlanImportModel, type UsageObserver, type WeekInput, type WeekResult } from './model';
import { PlanImportModelError, runModelCall, type ModelFailureReason } from './retry';
import { groundWeek } from './ground-week';
import { normalizeDateCells } from './input';
import { flagInferred } from './inferred';
import { validateExercises } from './validate-exercises';
import { parseWeekSkeleton } from './week-skeleton';

export async function parseWeeks(
  model: PlanImportModel,
  inputs: WeekInput[],
  onUsage?: UsageObserver,
) {
  const results: (
    | WeekResult
    | { index: number; error: 'PARSE_FAILED'; reason: ModelFailureReason }
  )[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, inputs.length) }, async () => {
      while (next < inputs.length) {
        const position = next++;
        const input = inputs[position];
        if (!input) return;
        try {
          const parse = async (correction_cells?: [number, number][]) => {
            const result = parseWeekSkeleton(
              await model.parseWeek(
                {
                  ...input,
                  cells: normalizeDateCells(input.cells),
                  header_cells: normalizeDateCells(input.header_cells),
                  ...(correction_cells ? { correction_cells } : {}),
                },
                onUsage,
              ),
              input.cells,
              input.header_cells,
            );
            if (result.index !== input.index) throw new Error('INVALID_WEEK_INDEX');
            return flagInferred(
              groundWeek(validateExercises(result, input.cells), input.cells, input.header_cells),
              input.cells,
            );
          };
          const first = await runModelCall(() => parse());
          results[position] = first;
          const others = first.unreadable.filter((item) => item.reason === 'OTHER');
          if (others.length > 0) {
            const coordinates = [
              ...new Map(
                others
                  .flatMap((item) => item.source_cells)
                  .map((ref) => [JSON.stringify(ref), ref]),
              ).values(),
            ];
            try {
              // One corrective call, inside the claimed HTTP call. Reuse the
              // usage observer even if this candidate is discarded or fails.
              const corrected = await parse(coordinates);
              if (
                corrected.unreadable.filter((item) => item.reason === 'OTHER').length <
                others.length
              )
                results[position] = corrected;
            } catch {
              // A usable first result must survive a failed correction.
            }
          }
        } catch (error) {
          results[position] = {
            index: input.index,
            error: 'PARSE_FAILED',
            reason: error instanceof PlanImportModelError ? error.reason : 'BAD_OUTPUT',
          };
        }
      }
    }),
  );
  return results;
}
