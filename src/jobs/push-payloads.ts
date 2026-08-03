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

export type PushPayloadBuilder = (payload: unknown) => PushPayloadBuildResult;

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

const DailyDigestSchema = z
  .object({
    aps: z.object({ alert: AlertSchema }).passthrough(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    gym_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .passthrough();

export const PUSH_PAYLOAD_BUILDERS = {
  chat_message: (payload) => {
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
  missed_training: (payload) => {
    const value = MissedTrainingSchema.parse(decodedPayload(payload));
    return {
      alert: {
        title: '学员缺练提醒',
        body: `${value.student_name}已 ${String(value.consecutive_days)} 天未训练`,
      },
      threadId: 'missed_training',
      custom: { kind: 'missed_training', student_id: value.student_id },
    };
  },
  pr_congrats: (payload) => {
    const value = PrCongratsSchema.parse(decodedPayload(payload));
    return {
      alert: {
        title: '破 PR 🎉',
        body: `${value.student_name} ${value.lift_name} e1RM 新高 ↑${formatKilograms(value.increase_kg)}kg`,
      },
      threadId: 'pr_congrats',
      custom: { kind: 'pr_congrats', student_id: value.student_id },
    };
  },
  video_pending: (payload) => {
    const value = VideoPendingSchema.parse(decodedPayload(payload));
    return {
      alert: {
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
  bind_request: (payload) => {
    const value = BindRequestSchema.parse(decodedPayload(payload));
    return {
      alert: { title: '新学员申请', body: `${value.student_name} 申请绑定` },
      threadId: 'bind_request',
      custom: { kind: 'bind_request', request_id: value.request_id },
    };
  },
  plan_shift: (payload) => {
    const value = PlanShiftSchema.parse(decodedPayload(payload));
    return {
      alert: {
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
): PushPayloadBuildResult {
  return PUSH_PAYLOAD_BUILDERS[eventType](payload);
}
