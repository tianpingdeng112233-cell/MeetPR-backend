import { z } from 'zod';
import { SetRefV1Schema } from './set-ref';

export const ExerciseRefV1Schema = z
  .object({
    v: z.literal(1),
    exercise_name: SetRefV1Schema.innerType().shape.exercise_name,
    day_date: SetRefV1Schema.innerType().shape.day_date,
    plan_day_id: z.string().uuid().nullable(),
    plan_exercise_id: z.string().uuid().nullable(),
    exercise_id: z.string().uuid(),
  })
  .strict();

export type ExerciseRefV1 = z.infer<typeof ExerciseRefV1Schema>;

export function bodyMatchesExerciseRef(body: string, ref: ExerciseRefV1, locale?: string): boolean {
  const prefix = locale === 'en' ? '[Exercise note]' : '[动作留言]';
  const month = Number(ref.day_date.slice(5, 7));
  const day = Number(ref.day_date.slice(8, 10));
  const firstLine = `${prefix} ${ref.exercise_name} · ${String(month)}/${String(day)}`;
  return body === firstLine || body.startsWith(`${firstLine}\n`);
}
