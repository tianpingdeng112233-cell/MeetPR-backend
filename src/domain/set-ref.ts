import { z } from 'zod';

import { isIsoCalendarDate, isoCalendarDateSchemaMessage } from '../utils/date';

const WEIGHT_PATTERN = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,2}))?$/;
const RPE_PATTERN = /^(10|[0-9](\.5)?)$/;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a canonical decimal weight without passing through binary floating
 * point. A null result means either the lexical form is invalid/non-canonical
 * or the value is outside the v1 snapshot domain.
 */
export function parseCanonicalWeightMinorUnits(value: string): number | null {
  const match = WEIGHT_PATTERN.exec(value);
  if (!match) return null;

  const integerText = match[1];
  const fractionText = match[2];
  if (integerText === undefined) return null;
  if (fractionText?.endsWith('0') === true) return null;

  const minorUnits =
    Number(integerText) * 100 +
    (fractionText === undefined ? 0 : Number(fractionText) * (fractionText.length === 1 ? 10 : 1));
  return minorUnits <= 999_999 ? minorUnits : null;
}

/**
 * Parse canonical RPE tenths from regex captures. v1 deliberately accepts
 * only integer and half-step values, never the looser set-log 0.1-step shape.
 */
export function parseCanonicalRpeMinorUnits(value: string): number | null {
  const match = RPE_PATTERN.exec(value);
  if (!match) return null;

  const canonicalText = match[1];
  if (canonicalText === undefined) return null;
  const integerText = match[2] === undefined ? canonicalText : canonicalText.slice(0, -2);
  return Number(integerText) * 10 + (match[2] === undefined ? 0 : 5);
}

const CanonicalWeightSchema = z
  .string()
  .refine((value) => parseCanonicalWeightMinorUnits(value) !== null, {
    message: 'weight_kg must be a canonical decimal from 0 through 9999.99',
  });

const CanonicalRpeSchema = z
  .string()
  .refine((value) => parseCanonicalRpeMinorUnits(value) !== null, {
    message: 'rpe must be a canonical 0.5-step decimal from 0 through 10',
  });

export const SetRefV1Schema = z
  .object({
    v: z.literal(1),
    exercise_name: z
      .string()
      .min(1)
      .refine((value) => Array.from(value).length <= 120, {
        message: 'exercise_name must contain at most 120 Unicode code points',
      })
      .refine((value) => !containsControlCharacter(value), {
        message: 'exercise_name must not contain newlines or control characters',
      }),
    set_number: z.number().int().min(1).max(2_147_483_648),
    weight_kg: CanonicalWeightSchema.nullable(),
    reps: z.number().int().min(0).max(99).nullable(),
    rpe: CanonicalRpeSchema.nullable(),
    day_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
      .refine(isIsoCalendarDate, isoCalendarDateSchemaMessage()),
    set_log_id: z.string().uuid(),
  })
  .strict();

export type SetRefV1 = z.infer<typeof SetRefV1Schema>;

export function formatSetRefFirstLine(setRef: SetRefV1): string {
  const weight = setRef.weight_kg ?? '-';
  const reps = String(setRef.reps ?? '-');
  const rpe = setRef.rpe === null ? '' : ` @RPE${setRef.rpe}`;
  return `[训练分享] ${setRef.exercise_name} 第${String(setRef.set_number)}组 ${weight}kg×${reps}${rpe} (${setRef.day_date})`;
}

export function bodyMatchesSetRef(body: string, setRef: SetRefV1): boolean {
  const firstLine = formatSetRefFirstLine(setRef);
  return body === firstLine || body.startsWith(`${firstLine}\n`);
}
