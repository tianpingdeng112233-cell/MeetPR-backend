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

/** A session logged before this local wall-clock hour belongs to the previous day. */
export const TRAINING_DAY_CUTOFF_HOUR = 4;

/**
 * Server-clock training day for clients that do not send logged_date. The
 * cutoff is 04:00 on the user's wall clock, not four elapsed hours before the
 * instant: those differ on 23/25-hour DST transition days.
 */
export function trainingDay(now: Date, timezone: string): string {
  const localDate = localCalendarDate(now, timezone);
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour')?.value;
  if (hour === undefined) throw new Error(`Unable to derive local hour for ${timezone}`);
  if (Number(hour) >= TRAINING_DAY_CUTOFF_HOUR) return localDate;

  const previousDate = utcDate(localDate);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  return utcDateOnly(previousDate);
}

/** Calendar date in an IANA timezone, for non-gym-day plan calendar rules. */
export function localCalendarDate(now: Date, timezone: string): string {
  return now.toLocaleDateString('en-CA', { timeZone: timezone });
}

/** @deprecated Use trainingDay(now, timezone) for user-owned dates. */
export function shanghaiTrainingDay(now: Date = new Date()): string {
  return trainingDay(now, 'Asia/Shanghai');
}
