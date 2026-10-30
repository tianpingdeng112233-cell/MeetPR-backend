import { dailyDigestBody } from './daily-digest';
import { copy, catalogName } from '../i18n/copy';
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
export type PushLocale = 'zh' | 'zh-Hant' | 'en';

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
    : copy(locale, '{0}月{1}日', [String(monthNumber), String(dayNumber)]);
}

export type PushPayloadBuilder = (payload: unknown, locale?: PushLocale) => PushPayloadBuildResult;

function decodedPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  return JSON.parse(payload) as unknown;
}

/** Only explicit producer provenance distinguishes system copy from an identical nickname. */
function displayName(name: string, isFallback: boolean | undefined, locale: PushLocale): string {
  if (!isFallback) return name;
  if (name === '教练') return copy(locale, '教练');
  if (name === '学员') return copy(locale, '学员');
  return name;
}

function formatKilograms(value: number): string {
  return String(Number(value.toFixed(2)));
}

const ChatMessageSchema = z
  .object({
    sender_name: DisplayNameSchema,
    display_name_is_fallback: z.boolean().optional(),
    preview_is_system: z.boolean().optional(),
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
    display_name_is_fallback: z.boolean().optional(),
    consecutive_days: z.number().int().positive(),
    student_id: UuidSchema,
  })
  .strict();

const PrCongratsSchema = z
  .object({
    student_name: DisplayNameSchema,
    display_name_is_fallback: z.boolean().optional(),
    lift_name: z.string().trim().min(1),
    increase_kg: z.number().positive().finite(),
    student_id: UuidSchema,
  })
  .strict();

const VideoPendingSchema = z
  .object({
    student_name: DisplayNameSchema,
    display_name_is_fallback: z.boolean().optional(),
    exercise_name: z.string().trim().min(1),
    exercise_is_custom: z.boolean().optional(),
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

const BindAcceptedSchema = z
  .object({
    coach_name: z.string().trim().nullish(),
    student_id: UuidSchema,
    request_id: UuidSchema,
  })
  .strict();

const PlanShiftSchema = z
  .object({
    student_name: DisplayNameSchema,
    display_name_is_fallback: z.boolean().optional(),
    shift_days: z.number().int().positive(),
    student_id: UuidSchema,
    plan_id: UuidSchema,
  })
  .strict();

const PlanUpdatedSchema = z
  .object({
    coach_name: DisplayNameSchema,
    display_name_is_fallback: z.boolean().optional(),
    student_id: UuidSchema,
    plan_id: UuidSchema,
  })
  .strict();

const PlanShiftedSchema = z
  .object({
    coach_name: DisplayNameSchema,
    display_name_is_fallback: z.boolean().optional(),
    student_id: UuidSchema,
    plan_id: UuidSchema,
    anchor_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    offset_days: z.number().int().min(1).max(30),
  })
  .strict();

const PlanShiftUndoneSchema = z
  .object({
    coach_name: DisplayNameSchema,
    display_name_is_fallback: z.boolean().optional(),
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
    locale: z.enum(['zh', 'zh-Hant', 'en']).optional(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    gym_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .passthrough();

export const PUSH_PAYLOAD_BUILDERS = {
  // Only marked system fallbacks/placeholders are copy; user content stays unchanged.
  chat_message: (payload, locale = 'zh') => {
    const value = ChatMessageSchema.parse(decodedPayload(payload));
    value.sender_name = displayName(value.sender_name, value.display_name_is_fallback, locale);
    return {
      alert: {
        title: value.sender_name,
        body:
          value.preview_is_system && value.preview === '[图片]'
            ? copy(locale, '[图片]')
            : value.preview_is_system && value.preview === '[训练组]'
              ? copy(locale, '[训练组]')
              : value.preview,
      },
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
    value.student_name = displayName(value.student_name, value.display_name_is_fallback, locale);
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Missed training',
              body: `${value.student_name} hasn't trained for ${String(value.consecutive_days)} ${dayWord(value.consecutive_days)}`,
            }
          : {
              title: copy(locale, '学员缺练提醒'),
              body: copy(locale, '{0}已 {1} 天未训练', [
                value.student_name,
                String(value.consecutive_days),
              ]),
            },
      threadId: 'missed_training',
      custom: { kind: 'missed_training', student_id: value.student_id },
    };
  },
  pr_congrats: (payload, locale = 'zh') => {
    const value = PrCongratsSchema.parse(decodedPayload(payload));
    value.student_name = displayName(value.student_name, value.display_name_is_fallback, locale);
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
              title: copy(locale, '破 PR 🎉'),
              body: copy(locale, '{0} {1} 实测重量新高 ↑{2}kg', [
                value.student_name,
                catalogName(value.lift_name, null, locale),
                formatKilograms(value.increase_kg),
              ]),
            },
      threadId: 'pr_congrats',
      custom: { kind: 'pr_congrats', student_id: value.student_id },
    };
  },
  video_pending: (payload, locale = 'zh') => {
    const value = VideoPendingSchema.parse(decodedPayload(payload));
    value.student_name = displayName(value.student_name, value.display_name_is_fallback, locale);
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
              title: copy(locale, '新视频待反馈'),
              body: copy(locale, '{0}上传了 {1} 视频', [
                value.student_name,
                value.exercise_name === '训练' && value.exercise_is_custom === false
                  ? copy(locale, '训练')
                  : catalogName(
                      value.exercise_name,
                      value.exercise_is_custom === false ? null : 'custom',
                      locale,
                    ),
              ]),
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
          : {
              title: copy(locale, '新学员申请'),
              body: copy(locale, '{0} 申请绑定', [value.student_name]),
            },
      threadId: 'bind_request',
      custom: { kind: 'bind_request', request_id: value.request_id },
    };
  },
  bind_accepted: (payload, locale = 'zh') => {
    const value = BindAcceptedSchema.parse(decodedPayload(payload));
    const coachName = value.coach_name;
    return {
      alert:
        locale === 'en'
          ? {
              title: `${coachName && cjkFree(coachName) ? coachName : 'Your coach'} accepted your request`,
              body: "Open MeetPR to see what's next",
            }
          : {
              title: coachName
                ? copy(locale, '{0}已接受你的申请', [coachName])
                : copy(locale, '教练已接受你的申请'),
              body: copy(locale, '打开 MeetPR 看看接下来做什么'),
            },
      collapseId: `bind-accepted-${value.request_id}`,
      threadId: 'bind_accepted',
      custom: {
        kind: 'bind_accepted',
        student_id: value.student_id,
        request_id: value.request_id,
      },
    };
  },
  plan_shift: (payload, locale = 'zh') => {
    const value = PlanShiftSchema.parse(decodedPayload(payload));
    value.student_name = displayName(value.student_name, value.display_name_is_fallback, locale);
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Plan shifted',
              body: `${value.student_name} shifted this cycle by ${String(value.shift_days)} ${dayWord(value.shift_days)}`,
            }
          : {
              title: copy(locale, '学员顺延了计划'),
              body: copy(locale, '{0} 将本周期顺延 {1} 天', [
                value.student_name,
                String(value.shift_days),
              ]),
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
    value.coach_name = displayName(value.coach_name, value.display_name_is_fallback, locale);
    return {
      alert:
        locale === 'en'
          ? {
              title: 'Your plan was updated',
              body: `${value.coach_name} adjusted your current plan`,
            }
          : {
              title: copy(locale, '教练更新了你的计划'),
              body: copy(locale, '{0} 调整了你正在练的计划，打开看看', [value.coach_name]),
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
    value.coach_name = displayName(value.coach_name, value.display_name_is_fallback, locale);
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
              title: copy(locale, '教练调整了你的计划日期'),
              body: copy(locale, '{0} 把 {1} 起的训练后移了 {2} 天', [
                coachName,
                planShiftDate(value.anchor_date, locale),
                String(value.offset_days),
              ]),
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
    value.coach_name = displayName(value.coach_name, value.display_name_is_fallback, locale);
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
              title: copy(locale, '教练撤销了上次的日期调整'),
              body: copy(locale, '{0} 恢复了原来的推荐日期', [coachName]),
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
              title: copy(locale, '教练发布了新计划'),
              body: copy(locale, '新的训练周期已经准备好，打开看看'),
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
  coach_daily_digest: (payload, locale = 'zh') => {
    const value = DailyDigestSchema.parse(decodedPayload(payload));
    return {
      alert:
        locale === 'zh-Hant' || value.locale !== undefined
          ? {
              title: locale === 'en' ? "Yesterday's training recap" : copy(locale, '昨日训练摘要'),
              body:
                dailyDigestBody(
                  {
                    session_completed: value.counts.session_completed ?? 0,
                    session_partial: value.counts.session_partial ?? 0,
                    missed_training: value.counts.missed_training ?? 0,
                    pr_e1rm: value.counts.pr_e1rm ?? 0,
                  },
                  locale,
                ) ?? value.aps.alert.body,
            }
          : value.aps.alert,
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
