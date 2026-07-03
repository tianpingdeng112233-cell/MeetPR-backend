import { z } from 'zod';

import { EVENT_PLATFORMS } from '../../db/types';

// Enum value sets (SPEC §8.1). The single source of truth is the iOS 043 Swift
// enums (the client is the event source, a compile-time closed set); this is the
// backend mirror. Adding a value = change both sides + bump schema_version.
const SCREENS = [
  'today_workout',
  'dashboard',
  'plan',
  'progress_history',
  'onboarding_wizard',
  'bind_enter_code',
  'pending_bind',
  'coach_roster',
  'coach_student_detail',
  'coach_receiving',
  'coach_planning',
  'coach_evaluation',
  'account',
] as const;
const FLOWS = [
  'record_set',
  'onboarding',
  'bind',
  'planning',
  'coach_intake',
  'coach_feedback',
] as const;
const FIELDS = [
  'weight',
  'reps',
  'rpe',
  'set_count',
  'bodyweight',
  'competition_date',
  'invite_code',
  'goal',
  'experience',
] as const;
const STEP_NAMES = [
  'goal',
  'experience',
  'lifts',
  'schedule',
  'competition',
  'equipment',
  'review',
] as const;

const uuid = z.string().uuid();
const int = z.number().int();
const nonNegInt = z.number().int().min(0);
const bool = z.boolean();

// client_error.code is a crash signal / HTTP code / NSError.code: an int OR a
// constrained symbolic token — length-capped, restricted charset, no control
// chars, no spaces. This honors "non-free-text" (SPEC §8.1) without hardcoding
// an open-ended enum the client can't yet enumerate.
const clientErrorCode = z.union([int, z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)]);

// Every per-event object shares these envelope fields. user_id/role are NOT here:
// they are server-derived and stripped from the client body before validation.
function ev<N extends string, T extends z.ZodRawShape>(name: N, props: z.ZodObject<T>) {
  return z
    .object({
      event_id: uuid,
      session_id: uuid,
      seq: nonNegInt,
      schema_version: z.number().int().positive().default(1),
      ts_client: z.string().datetime({ offset: true }),
      name: z.literal(name),
      props: props.strict(),
    })
    .strict();
}

// name enum allowlist + per-event strict props (SPEC §8). props are ids/int/bool/
// enum ONLY — never free text or measured values.
export const EventSchema = z.discriminatedUnion('name', [
  ev('app_open', z.object({ cold: bool })),
  ev('screen_view', z.object({ screen: z.enum(SCREENS) })),
  ev(
    'workout_log_start',
    z.object({ plan_id: uuid.optional(), source: z.enum(['dashboard', 'calendar']) }),
  ),
  ev(
    'set_logged',
    z.object({
      exercise_id: uuid,
      set_index: int,
      has_video: bool,
      outcome: z.enum(['completed', 'failed']),
    }),
  ),
  ev('workout_log_save', z.object({ n_sets: int, duration_ms: int })),
  ev('onboarding_step', z.object({ step_index: int, step_name: z.enum(STEP_NAMES) })),
  ev('onboarding_complete', z.object({ n_steps_filled: int, used_draft_resume: bool })),
  ev('bind_coach_action', z.object({ stage: z.enum(['invite_open', 'submitted', 'accepted']) })),
  ev('plan_viewed', z.object({ plan_id: uuid })),
  ev('progress_viewed', z.object({ tab: z.enum(['e1rm', 'volume', 'history']) })),
  ev('coach_open_student', z.object({ student_id: uuid })),
  ev('coach_feedback_sent', z.object({ student_id: uuid, kind: z.enum(['text', 'video']) })),
  ev('coach_plan_assigned', z.object({ student_id: uuid })),
  ev(
    'coach_intake_action',
    z.object({
      stage: z.enum(['request_seen', 'accepted_eval', 'accepted_skip', 'rejected']),
      student_id: uuid,
    }),
  ),
  ev(
    'eval_summary_action',
    z.object({ stage: z.enum(['draft_saved', 'delivered']), student_id: uuid }),
  ),
  ev('validation_error', z.object({ flow: z.enum(FLOWS), field: z.enum(FIELDS) })),
  ev('field_re_edit', z.object({ flow: z.enum(FLOWS), field: z.enum(FIELDS), count: int })),
  ev('nav_back', z.object({ from_screen: z.enum(SCREENS), in_flow: z.enum(FLOWS) })),
  ev('flow_cancel', z.object({ flow: z.enum(FLOWS), from_screen: z.enum(SCREENS) })),
  ev(
    'client_error',
    z.object({
      domain: z.enum(['network', 'decode', 'persistence', 'ui', 'unknown']),
      code: clientErrorCode,
      screen: z.enum(SCREENS),
    }),
  ),
  ev(
    'friction_feedback',
    z.object({
      flow: z.enum(FLOWS),
      from_screen: z.enum(SCREENS),
      trigger: z.enum(['re_edit', 'flow_cancel']),
    }),
  ),
  // GATED IN: spec 027 video upload ships in the beta, so media_upload is in the
  // allowlist (SPEC §8 media_upload note).
  ev(
    'media_upload',
    z.object({
      stage: z.enum(['started', 'succeeded', 'failed']),
      context: z.enum(['onboarding', 'set_log', 'coach_feedback']),
      bytes: int.optional(),
    }),
  ),
]);

export type ParsedEvent = z.infer<typeof EventSchema>;

// Batch envelope (SPEC §3). anon_id/app_version/build/platform are batch-level
// (one install, one build). Lenient on unknown top-level keys (forward-compat);
// events are validated per-element for partial-accept, so the array is unknown[]
// here. Length bounds (empty / >50) are enforced in the route for specific codes.
export const EventsBatchSchema = z.object({
  anon_id: uuid,
  app_version: z.string().max(64).optional(),
  build: z.string().max(64).optional(),
  platform: z.enum(EVENT_PLATFORMS).default('ios'),
  events: z.array(z.unknown()),
});

// Reject C0 control characters except tab (9), newline (10), carriage return (13).
// Detected by char code so no literal control byte appears in this source file.
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

// §4b: the ONE free-text path. text is the only free-text field — length-capped
// and control-chars rejected. Strict: unknown keys rejected after user_id/role
// are stripped.
export const FeedbackSchema = z
  .object({
    event_id: uuid,
    anon_id: uuid,
    session_id: uuid,
    flow: z.enum(FLOWS),
    from_screen: z.enum(SCREENS),
    trigger: z.enum(['re_edit', 'flow_cancel']),
    text: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((s) => !hasControlChars(s), 'no control chars'),
    app_version: z.string().max(64).optional(),
    build: z.string().max(64).optional(),
    ts_client: z.string().datetime({ offset: true }),
  })
  .strict();
