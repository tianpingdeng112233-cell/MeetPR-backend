export function uuidEquals(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}
