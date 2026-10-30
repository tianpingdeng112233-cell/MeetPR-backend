export type ModelFailureReason = 'MODEL_BUSY' | 'OUTPUT_TOO_LONG' | 'BAD_OUTPUT' | 'REGION_SUSPECT';

/** Safe public model error: never retains provider errors, bodies or cell text. */
export class PlanImportModelError extends Error {
  constructor(readonly reason: ModelFailureReason) {
    super('PARSE_FAILED');
  }
}

export class ModelAttemptsExhaustedError extends PlanImportModelError {}

/** Shared by the HTTP adapter and orchestration; nested boundaries never multiply retries. */
export async function runModelCall<T>(call: () => Promise<T>): Promise<T> {
  let reason: ModelFailureReason = 'BAD_OUTPUT';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ModelAttemptsExhaustedError) throw error;
      reason = error instanceof PlanImportModelError ? error.reason : 'BAD_OUTPUT';
    }
  }
  throw new ModelAttemptsExhaustedError(reason);
}
