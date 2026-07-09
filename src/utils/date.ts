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
