type TimestampValue = Date | string;

export function timestamp(value: TimestampValue): string {
  return value instanceof Date ? value.toISOString() : value;
}
