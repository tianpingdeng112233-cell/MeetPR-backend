import { z } from 'zod';

const UuidSchema = z.string().uuid();
const DisplayNameSchema = z.string().trim().min(1);
const AlertSchema = z.object({ title: z.string().min(1), body: z.string().min(1) }).strict();

export interface PushPayloadBuildResult {
  alert: z.infer<typeof AlertSchema>;
  collapseId?: string;
  threadId?: string;
  custom: Record<string, unknown>;
}

// Global-track recipients (phone IS NULL, spec 039) get English copy; the CN
// side keeps today's Chinese byte-for-byte. Wire payloads may carry Chinese
// display strings (exercise/lift names from the CN catalog); English bodies
// only embed them when they are CJK-free and fall back to neutral wording.
export type PushLocale = 'zh' | 'en';

const CJK_PATTERN = /\p{Script=Han}/u;

function cjkFree(value: string): boolean {
  return !CJK_PATTERN.test(value);
}

function dayWord(count: number): string {
  return count === 1 ? 'day' : 'days';
}

const ENGLISH_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function planShiftDate(value: string, locale: PushLocale): string {
  const [, month, day] = value.split('-');
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  return locale === 'en'
    ? `${ENGLISH_MONTHS[monthNumber - 1] ?? value} ${String(dayNumber)}`
    : `${String(monthNumber)}月${String(dayNumber)}日`;
}

export type PushPayloadBuilder = (payload: unknown, locale?: PushLocale) => PushPayloadBuildResult;

function decodedPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  return JSON.parse(payload) as unknown;
}

function formatKilograms(value: number): string {
  return String(Number(value.toFixed(2)));
}

const ChatMessageSchema = z
  .object({
    sender_name: DisplayNameSchema,
    // The write side truncates by Unicode code point (Array.from); measuring
    // UTF-16 code units here would reject emoji-heavy previews it produced.
    preview: z
      .string()
      .min(1)
      .refine((value) => Array.from(value).length <= 60, {
        message: 'preview exceeds 60 code points',
      }),
    conversation_id: UuidSchema,
    seq: z.number().int().positive(),
  })
  .strict();

const MissedTrainingSchema = z
  .object({
    student_name: DisplayNameSchema,
    consecutive_days: z.number().int().positive(),
    student_id: UuidSchema,
  })
  .strict();

const PrCongratsSchema = z
  .object({
    student_name: DisplayNameSchema,
    lift_name: z.string().trim().min(1),
    increase_kg: z.number().positive().finite(),
    student_id: UuidSchema,
  })
  .strict();

const VideoPendingSchema = z
  .object({
    student_name: DisplayNameSchema,
    exercise_name: z.string().trim().min(1),
    student_id: UuidSchema,
    video_id: UuidSchema,
  })
  .strict();

const BindRequestSchema = z
  .object({
    student_name: DisplayNameSchema,
    request_id: UuidSchema,
  })
  .strict();

const PlanShiftSchema = z
  .object({
    student_name: DisplayNameSchema,
    shift_days: z.number().int().positive(),
    student_id: UuidSchema,
    plan_id: UuidSchema,
  })
  .strict();

const PlanUpdatedSchema = z
  .object({
    coach_name: DisplayNameSchema,
    student_id: UuidSchema,
    plan_id: UuidSchema,
  })
  .strict();

const PlanShiftedSchema = z
  .object({
    coach_name: DisplayNameSchema,
    student_id: UuidSchema,
    plan_id: UuidSchema,
    anchor_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    offset_days: z.number().int().min(1).max(30),
  })
  .strict();

const PlanShiftUndoneSchema = z
  .object({
    coach_name: DisplayNameSchema,
    student_id: UuidSchema,
    plan_id: UuidSchema,
  })
  .strict();

const PlanPublishedSchema = z
  .object({
    plan_id: UuidSchema,
    trainee_id: UuidSchema,
  })
  .strict();

const DailyDigestSchema = z
  .object({
    aps: z.object({ alert: AlertSchema }).passthrough(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    gym_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .passthrough();

export const PUSH_PAYLOAD_BUILDERS = {
  // Sender name and preview are user content, not UI copy — identical in both
  // locales, but the builder still accepts the parameter so every registered
  // builder shares one call shape.
  chat_message: (payload, _locale = 'zh') => {
    const value = ChatMessageSchema.parse(decodedPayload(payload));
    return {
      alert: { title: value.sender_name, body: value.preview },
      collapseId: `conv-${value.conversation_id}`,
      threadId: 'chat_message',
      custom: {
        kind: 'chat_message',
        conversation_id: value.conversation_id,
        seq: value.seq,
      },
    };
  },
  missed_training: (payload, locale = 'zh') => {
    const value = MissedTrainingSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Missed training',
              body: `${value.student_name} hasn't trained for ${String(value.consecutive_days)} ${dayWord(value.consecutive_days)}`,
            }
          : {
              title: '学员缺练提醒',
              body: `${value.student_name}已 ${String(value.consecutive_days)} 天未训练`,
            },
      threadId: 'missed_training',
      custom: { kind: 'missed_training', student_id: value.student_id },
    };
  },
  pr_congrats: (payload, locale = 'zh') => {
    const value = PrCongratsSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'en'
          ? {
              title: 'New PR 🎉',
              body: cjkFree(value.lift_name)
                ? `${value.student_name} hit a new ${value.lift_name} weight PR ↑${formatKilograms(value.increase_kg)}kg`
                : `${value.student_name} hit a new weight PR ↑${formatKilograms(value.increase_kg)}kg`,
            }
          : {
              title: '破 PR 🎉',
              body: `${value.student_name} ${value.lift_name} 实测重量新高 ↑${formatKilograms(value.increase_kg)}kg`,
            },
      threadId: 'pr_congrats',
      custom: { kind: 'pr_congrats', student_id: value.student_id },
    };
  },
  video_pending: (payload, locale = 'zh') => {
    const value = VideoPendingSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'en'
          ? {
              title: 'New video to review',
              body: cjkFree(value.exercise_name)
                ? `${value.student_name} uploaded a ${value.exercise_name} video`
                : `${value.student_name} uploaded a training video`,
            }
          : {
              title: '新视频待反馈',
              body: `${value.student_name}上传了 ${value.exercise_name} 视频`,
            },
      collapseId: `vid-${value.student_id}`,
      threadId: 'video_pending',
      custom: {
        kind: 'video_pending',
        student_id: value.student_id,
        video_id: value.video_id,
      },
    };
  },
  bind_request: (payload, locale = 'zh') => {
    const value = BindRequestSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'en'
          ? { title: 'New student request', body: `${value.student_name} requested to link` }
          : { title: '新学员申请', body: `${value.student_name} 申请绑定` },
      threadId: 'bind_request',
      custom: { kind: 'bind_request', request_id: value.request_id },
    };
  },
  plan_shift: (payload, locale = 'zh') => {
    const value = PlanShiftSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Plan shifted',
              body: `${value.student_name} shifted this cycle by ${String(value.shift_days)} ${dayWord(value.shift_days)}`,
            }
          : {
              title: '学员顺延了计划',
              body: `${value.student_name} 将本周期顺延 ${String(value.shift_days)} 天`,
            },
      collapseId: `shift-${value.plan_id}`,
      threadId: 'plan_shift',
      custom: {
        kind: 'plan_shift',
        student_id: value.student_id,
        plan_id: value.plan_id,
      },
    };
  },
  plan_updated: (payload, locale = 'zh') => {
    const value = PlanUpdatedSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Your plan was updated',
              body: `${value.coach_name} adjusted your current plan`,
            }
          : {
              title: '教练更新了你的计划',
              body: `${value.coach_name} 调整了你正在练的计划，打开看看`,
            },
      collapseId: `plan-updated-${value.plan_id}`,
      threadId: 'plan_updated',
      custom: {
        kind: 'plan_updated',
        student_id: value.student_id,
        plan_id: value.plan_id,
      },
    };
  },
  plan_shifted: (payload, locale = 'zh') => {
    const value = PlanShiftedSchema.parse(decodedPayload(payload));
    const coachName =
      locale === 'en' && !cjkFree(value.coach_name) ? 'Your coach' : value.coach_name;
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Your plan dates changed',
              body: `${coachName} moved your training from ${planShiftDate(value.anchor_date, locale)} onward by ${String(value.offset_days)} ${dayWord(value.offset_days)}`,
            }
          : {
              title: '教练调整了你的计划日期',
              body: `${coachName} 把 ${planShiftDate(value.anchor_date, locale)} 起的训练后移了 ${String(value.offset_days)} 天`,
            },
      collapseId: value.plan_id,
      threadId: 'plan_updated',
      custom: {
        kind: 'plan_shifted',
        student_id: value.student_id,
        plan_id: value.plan_id,
      },
    };
  },
  plan_shift_undone: (payload, locale = 'zh') => {
    const value = PlanShiftUndoneSchema.parse(decodedPayload(payload));
    const coachName =
      locale === 'en' && !cjkFree(value.coach_name) ? 'Your coach' : value.coach_name;
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Plan date change undone',
              body: `${coachName} restored the previous dates`,
            }
          : {
              title: '教练撤销了上次的日期调整',
              body: `${coachName} 恢复了原来的推荐日期`,
            },
      collapseId: value.plan_id,
      threadId: 'plan_updated',
      custom: {
        kind: 'plan_shift_undone',
        student_id: value.student_id,
        plan_id: value.plan_id,
      },
    };
  },
  plan_published: (payload, locale = 'zh') => {
    const value = PlanPublishedSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'en'
          ? {
              title: 'New plan published',
              body: 'Your next training cycle is ready',
            }
          : {
              title: '教练发布了新计划',
              body: '新的训练周期已经准备好，打开看看',
            },
      collapseId: `plan-published-${value.plan_id}`,
      threadId: 'plan_published',
      custom: {
        kind: 'plan_published',
        student_id: value.trainee_id,
        plan_id: value.plan_id,
      },
    };
  },
  coach_daily_digest: (payload) => {
    const value = DailyDigestSchema.parse(decodedPayload(payload));
    return {
      alert: value.aps.alert,
      threadId: 'coach_daily_digest',
      custom: { kind: 'coach_daily_digest', counts: value.counts, gym_day: value.gym_day },
    };
  },
} satisfies Record<string, PushPayloadBuilder>;

export type RegisteredPushEventType = keyof typeof PUSH_PAYLOAD_BUILDERS;

export const REGISTERED_PUSH_EVENT_TYPES = Object.keys(
  PUSH_PAYLOAD_BUILDERS,
) as RegisteredPushEventType[];

export function buildPushPayload(
  eventType: RegisteredPushEventType,
  payload: unknown,
  locale: PushLocale = 'zh',
): PushPayloadBuildResult {
  return PUSH_PAYLOAD_BUILDERS[eventType](payload, locale);
}
