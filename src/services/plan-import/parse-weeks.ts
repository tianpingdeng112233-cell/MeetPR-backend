import {
  WeekResultSchema,
  type PlanImportModel,
  type UsageObserver,
  type WeekInput,
  type WeekResult,
} from './model';
import { PlanImportModelError, runModelCall, type ModelFailureReason } from './retry';
import { flagInferred } from './inferred';

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
            const result = WeekResultSchema.parse(await model.parseWeek(input, onUsage));
            if (result.index !== input.index) throw new Error('INVALID_WEEK_INDEX');
            return flagInferred(result, input.cells);
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
