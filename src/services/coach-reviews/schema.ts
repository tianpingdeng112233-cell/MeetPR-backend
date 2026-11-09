import { z } from 'zod';

/** Match PostgreSQL length(text), including characters outside the BMP. */
export function textByCharacters(min: number, max: number) {
  return z
    .string()
    .trim()
    .refine(
      (value) => {
        const length = Array.from(value).length;
        return length >= min && length <= max;
      },
      `must_contain_${String(min)}_to_${String(max)}_characters`,
    );
}

const text = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/1\d{10}/u.test(v), 'phone_not_public');
export const ListedCoachInput = z.object({
  name: text,
  nickname: text,
  gender: text,
  douyin_handle: text.transform((v) => v.toLowerCase()),
  douyin_url: z
    .string()
    .trim()
    .url()
    .max(1000)
    .refine((v) => {
      if (!URL.canParse(v)) return false;
      const url = new URL(v);
      return (
        url.protocol === 'https:' &&
        (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) &&
        !/1\d{10}/u.test(v)
      );
    }, 'invalid_douyin_url'),
  province: text,
  city: text,
  gyms: z.array(text).min(1).max(20),
  teaching_mode: z.enum(['线下', '线上', '线上+线下']),
  best_total_kg: z.number().finite().nonnegative().nullable().default(null),
  competition_class: text.nullable().default(null),
  equipment: z.enum(['无装备', '单层装备', '多层装备']).nullable().default(null),
  certifications: text.nullable().default(null),
  coaching_years: z.number().finite().nonnegative().nullable().default(null),
});
export const Id = z.string().uuid();
