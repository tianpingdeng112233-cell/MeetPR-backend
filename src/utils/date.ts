/**
 * True only for a real Gregorian calendar date in the API's YYYY-MM-DD wire
 * format. A regex alone accepts values such as 2026-02-30 which PostgreSQL
 * then turns into an opaque 500-level constraint error.
 */
export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isoCalendarDateSchemaMessage(): string {
  return 'Date must be a real YYYY-MM-DD calendar date';
}

/** Convert a YYYY-MM-DD API date into a UTC date without locale-dependent parsing. */
export function utcDate(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const [yearText, monthText, dayText] = value.split('-');
  return new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
}

export function utcDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Normalize a database DATE value across node-postgres and pg-mem. */
export function normalizeDateOnly(value: string | Date): string {
  return value instanceof Date ? utcDateOnly(value) : value;
}

/**
 * A session logged before this hour (Asia/Shanghai) still belongs to the
 * previous calendar day: training days follow the gym clock, not midnight.
 */
export const TRAINING_DAY_CUTOFF_HOUR = 4;

/**
 * Server-clock training day for clients that do not send logged_date.
 * Shanghai has no DST, so shifting the instant back by the cutoff before
 * taking the calendar date is exact.
 */
export function shanghaiTrainingDay(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - TRAINING_DAY_CUTOFF_HOUR * 60 * 60 * 1000);
  return shifted.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
