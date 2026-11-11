/** Capability applies only to actual set-log weights, never planned loads or body weight. */
export function serializeSetLogWeight<T extends { weight_kg: string | number | null }>(
  row: T,
  caps?: string | string[],
): Omit<T, 'weight_kg'> & { weight_kg: string | null } {
  const nullable = (Array.isArray(caps) ? caps.join(',') : (caps ?? ''))
    .split(',')
    .some((cap) => cap.trim() === 'set-weight-nullable');
  return {
    ...row,
    weight_kg: row.weight_kg === null ? (nullable ? null : '0') : Number(row.weight_kg).toFixed(2),
  };
}
