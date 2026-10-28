import {
  WeekSkeletonSchema,
  type PlanImportModel,
  type UsageObserver,
  type WeekInput,
  type WeekResult,
} from './model';
import { PlanImportModelError, runModelCall, type ModelFailureReason } from './retry';
import { groundWeek } from './ground-week';
import { normalizeDateCells } from './input';
import { flagInferred } from './inferred';
import { validateExercises } from './validate-exercises';
import { normalizeOrdinalWeek } from './day-cycles';

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
          results[position] = await runModelCall(async () => {
            const result = WeekSkeletonSchema.parse(
              normalizeOrdinalWeek(
                await model.parseWeek(
                  {
                    ...input,
                    cells: normalizeDateCells(input.cells),
                    header_cells: normalizeDateCells(input.header_cells),
                  },
                  onUsage,
                ),
                input.cells,
              ),
            );
            if (result.index !== input.index) throw new Error('INVALID_WEEK_INDEX');
            return flagInferred(
              groundWeek(validateExercises(result, input.cells), input.cells, input.header_cells),
              input.cells,
            );
          });
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
