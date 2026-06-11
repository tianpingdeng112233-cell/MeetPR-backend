type TimestampValue = Date | string;

export function timestamp(value: TimestampValue): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Normalize a nullable NUMERIC column to a fixed-decimals wire string.
 * pg returns NUMERIC as string; pg-mem (tests) returns a JS number.
 */
export function decimal(value: string | number | null, digits: number): string | null {
  return value === null ? null : Number(value).toFixed(digits);
}

/**
 * Normalize a nullable DATE column to YYYY-MM-DD. pg returns text via the
 * OID 1082 parser (DATE-as-text hard rule); pg-mem (tests) returns a Date.
 */
export function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
