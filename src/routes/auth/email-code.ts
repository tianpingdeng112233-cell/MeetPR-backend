import { createHash, timingSafeEqual } from 'node:crypto';

export function codeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
