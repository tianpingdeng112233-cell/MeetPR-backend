import type { Response } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types';
import { moderateCoachReview } from './moderation';
import { textByCharacters } from './schema';
const rating = z.number().int().min(1).max(5);
export const CoachReviewInput = z.object({
  overall: rating,
  professionalism: rating,
  communication: rating,
  results: rating,
  value: rating,
  body: textByCharacters(10, 1000),
});
export async function rejectBlockedReview(db: Kysely<Database>, body: string, res: Response) {
  const words = await db.selectFrom('coach_review_words').select('word').execute();
  const reason = moderateCoachReview(
    body,
    words.map((w) => w.word),
  );
  if (reason) res.status(400).json({ error: 'COACH_REVIEW_BLOCKED', reason });
  return reason !== null;
}
export function isUniqueConflict(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
