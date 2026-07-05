const TM_ROUNDING_KG = 2.5;
const TM_RATIO = 0.9;
const TM_FRESHNESS_DAYS = 42;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function calculateTrainingMaxKg(oneRmKg: number): number {
  if (!Number.isFinite(oneRmKg) || oneRmKg <= 0) {
    throw new RangeError('oneRmKg must be a positive finite number');
  }

  const rounded = Math.ceil((oneRmKg * TM_RATIO) / TM_ROUNDING_KG) * TM_ROUNDING_KG;
  return Math.round(rounded * 100) / 100;
}

export function formatTrainingMaxKg(trainingMaxKg: number): string {
  return trainingMaxKg.toFixed(2);
}

export function isTrainingMaxFresh(tmSetAt: Date | string | null, now: Date = new Date()): boolean {
  if (tmSetAt === null) return false;

  const setAt = tmSetAt instanceof Date ? tmSetAt : new Date(tmSetAt);
  if (Number.isNaN(setAt.getTime())) return false;

  return now.getTime() <= setAt.getTime() + TM_FRESHNESS_DAYS * MS_PER_DAY;
}
