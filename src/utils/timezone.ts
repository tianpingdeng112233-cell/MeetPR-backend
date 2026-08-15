export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

// Node 22 sources this list from the process ICU/tzdata bundle. Cache it once
// at module startup: registration and PATCH validation are hot request paths,
// while the supported-zone set changes only when the process is redeployed.
const SUPPORTED_TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

export function isSupportedTimeZone(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_TIME_ZONES.has(value);
}

export function requestedTimeZone(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('timezone' in body)) {
    return DEFAULT_TIME_ZONE;
  }
  const timezone = (body as { timezone?: unknown }).timezone;
  return isSupportedTimeZone(timezone) ? timezone : null;
}
