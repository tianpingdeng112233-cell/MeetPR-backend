import type { ColumnType, Generated } from 'kysely';

import type { SetRefV1 } from '../domain/set-ref';

export const USER_ROLES = ['coach', 'coached_student', 'self_train_student', 'admin'] as const;
export const REGISTERABLE_ROLES = ['coach', 'coached_student', 'self_train_student'] as const;
export const LIFT_FAMILIES = ['squat', 'bench', 'deadlift'] as const;
export const COMPETITION_STANCES = ['low_bar', 'high_bar', 'conventional', 'sumo'] as const;
export const EXERCISE_TYPES = ['main_lift', 'main_lift_variation', 'accessory'] as const;
export const MUSCLE_GROUPS = [
  'adductor',
  'back',
  'biceps',
  'calf',
  'cardio',
  'chest',
  'core',
  'forearm',
  'glute',
  'grip',
  'hamstring',
  'hip',
  'hip_flexor',
  'mobility',
  'quad',
  'shoulder',
  'tibialis',
  'trap',
  'triceps',
] as const;
export const EQUIPMENT = [
  'band',
  'barbell',
  'bodyweight',
  'cable',
  'dumbbell',
  'kettlebell',
  'machine',
  'other',
  'specialty_bar',
] as const;
export const MOVEMENT_PATTERNS = [
  'squat',
  'hip_hinge',
  'horizontal_push',
  'vertical_push',
  'horizontal_pull',
  'vertical_pull',
  'warm_up',
  'other',
] as const;
export const PLAN_SOURCES = ['coach', 'template', 'algorithm'] as const;
export const API_PLAN_SOURCES = ['coach', 'template'] as const;
export const PLAN_STATUSES = ['draft', 'published', 'completed', 'paused'] as const;
export const PATCHABLE_PLAN_STATUSES = ['published', 'paused', 'completed'] as const;
export const PLAN_DAY_COMPLETION_SOURCES = ['auto', 'manual', 'backfill'] as const;
export const INTENSITY_MODES = ['weight', 'rpe'] as const;
export const SET_TYPES = ['warmup', 'working', 'failed', 'amrap', 'backoff'] as const;
export const BIND_REQUEST_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
] as const;
export const PLAN_KINDS = ['regular', 'adaptation'] as const;
export const INVITE_CODE_TYPES = ['personal_permanent', 'single_use', 'time_limited'] as const;
export const EVALUATION_COMPLETION_TYPES = [
  'coach_completed',
  'auto_completed',
  'overdue',
  'cancelled',
] as const;
export const UNIT_PREFERENCES = ['kg', 'lb'] as const;
export const GENDERS = ['male', 'female', 'other'] as const;
export const SQUAT_STANCES = ['high_bar', 'low_bar'] as const;
export const DEADLIFT_STYLES = ['conventional', 'sumo', 'both'] as const;
export const BENCH_GRIPS = ['narrow', 'standard', 'wide'] as const;
export const GYM_TIERS = ['home_with_rack', 'commercial', 'professional'] as const;
export const METHOD_ANCHORS = ['linear_load', 'tm_pct', 'e1rm_rpe', 'double_progression'] as const;
export const DEV_STAGES = ['novice', 'intermediate', 'advanced'] as const;
export const BLOCK_TYPES = ['hypertrophy', 'strength', 'peaking', 'active_rest'] as const;
export const MESOCYCLE_PHASES = [
  'accumulation',
  'intensification',
  'realization',
  'deload',
] as const;
export const E1RM_CONFIDENCES = ['normal', 'low'] as const;
export const EFFORT_METHODS = ['max', 'dynamic', 'repetition'] as const;
export const TRAINING_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const INJURY_AREAS = [
  'shoulder',
  'elbow',
  'wrist',
  'lower_back',
  'hip',
  'knee',
  'ankle',
  'other',
] as const;
// Readiness check-in muscle vocabulary. Single source of truth on the iOS side
// is ReadinessCheckin.allowedMuscleGroups (spec 030 §C1) — this is its verbatim
// mirror. Adding a muscle group = change both sides + tests + spec revision.
export const READINESS_MUSCLE_GROUPS = [
  'quad',
  'hamstring',
  'glute',
  'back',
  'chest',
  'shoulder',
  'triceps',
  'core',
] as const;
export const ATTACHMENT_KINDS = [
  'set_video',
  'onboarding_video',
  'onboarding_doc',
  'chat_image',
] as const;
export const ATTACHMENT_STATUSES = [
  'uploading',
  'completing',
  'aborting',
  'ready',
  'aborted',
  'failed',
  'deleting',
] as const;
export const VIDEO_MARKER_LEVELS = ['info', 'warn', 'bad'] as const;
// Analytics event platform. The column is text for forward-compat; this const
// is the current closed set (SPEC 008 §6). 'android' added 2026-07-19 for the
// RN Android client (meetpr-rn W0).
export const EVENT_PLATFORMS = ['ios', 'android'] as const;
export const SESSION_STATUSES = ['in_progress', 'completed', 'partial'] as const;
export const STUDENT_EVENT_TYPES = ['session_completed', 'session_partial', 'pr_e1rm'] as const;
export const SIGNAL_TYPES = ['missed_training', 'pr_congrats'] as const;
export const SIGNAL_SEVERITIES = ['red', 'yellow', 'green'] as const;
export const SIGNAL_STATUSES = ['open', 'acked', 'auto_resolved', 'expired'] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type LiftFamily = (typeof LIFT_FAMILIES)[number];
export type CompetitionStance = (typeof COMPETITION_STANCES)[number];
export type ExerciseType = (typeof EXERCISE_TYPES)[number];
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];
export type Equipment = (typeof EQUIPMENT)[number];
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];
export type PlanSource = (typeof PLAN_SOURCES)[number];
export type ApiPlanSource = (typeof API_PLAN_SOURCES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanDayCompletionSource = (typeof PLAN_DAY_COMPLETION_SOURCES)[number];
export type PatchablePlanStatus = (typeof PATCHABLE_PLAN_STATUSES)[number];
export type IntensityMode = (typeof INTENSITY_MODES)[number];
export type SetType = (typeof SET_TYPES)[number];
export type BindRequestStatus = (typeof BIND_REQUEST_STATUSES)[number];
export type PlanKind = (typeof PLAN_KINDS)[number];
export type InviteCodeType = (typeof INVITE_CODE_TYPES)[number];
export type EvaluationCompletionType = (typeof EVALUATION_COMPLETION_TYPES)[number];
export type UnitPreference = (typeof UNIT_PREFERENCES)[number];
export type Gender = (typeof GENDERS)[number];
export type SquatStance = (typeof SQUAT_STANCES)[number];
export type DeadliftStyle = (typeof DEADLIFT_STYLES)[number];
export type BenchGrip = (typeof BENCH_GRIPS)[number];
export type GymTier = (typeof GYM_TIERS)[number];
export type MethodAnchor = (typeof METHOD_ANCHORS)[number];
export type DevStage = (typeof DEV_STAGES)[number];
export type BlockType = (typeof BLOCK_TYPES)[number];
export type MesocyclePhase = (typeof MESOCYCLE_PHASES)[number];
export type E1rmConfidence = (typeof E1RM_CONFIDENCES)[number];
export type EffortMethod = (typeof EFFORT_METHODS)[number];
export type TrainingDay = (typeof TRAINING_DAYS)[number];
export type InjuryArea = (typeof INJURY_AREAS)[number];
export type ReadinessMuscleGroup = (typeof READINESS_MUSCLE_GROUPS)[number];
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];
export type VideoMarkerLevel = (typeof VIDEO_MARKER_LEVELS)[number];
export type EventPlatform = (typeof EVENT_PLATFORMS)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type StudentEventType = (typeof STUDENT_EVENT_TYPES)[number];
export type SignalType = (typeof SIGNAL_TYPES)[number];
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

type NullableColumn<T> = ColumnType<T | null, T | null | undefined, T | null>;
type TimestampColumn = ColumnType<Date, Date | undefined, Date>;
type NumericColumn = ColumnType<string, string | number | undefined, string | number>;
type NullableNumericColumn = ColumnType<
  string | null,
  string | number | null | undefined,
  string | number | null
>;
type NullableJsonColumn<T> = ColumnType<T | null, T | string | null | undefined, T | string | null>;

export interface UsersTable {
  id: Generated<string>;
  phone: string;
  apple_user_id: NullableColumn<string>;
  password_hash: string;
  role: UserRole;
  refresh_token_jti: NullableColumn<string>;
  is_test: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  refresh_token_jti: string;
  prev_jti: NullableColumn<string>;
  prev_jti_valid_until: NullableColumn<Date>;
  created_at: Generated<Date>;
  last_used_at: Generated<Date>;
  revoked_at: NullableColumn<Date>;
}

export interface ExercisesTable {
  id: Generated<string>;
  name: string;
  name_en: NullableColumn<string>;
  exercise_type: ExerciseType;
  main_lift_family: NullableColumn<LiftFamily>;
  is_competition_lift: Generated<boolean>;
  competition_stance: NullableColumn<CompetitionStance>;
  muscle_groups: MuscleGroup[];
  equipment: Equipment[];
  movement_pattern: Generated<MovementPattern[]>;
  created_by_coach_id: NullableColumn<string>;
  created_at: TimestampColumn;
  base_exercise_id: NullableColumn<string>;
  stance: NullableColumn<string>;
  grip: NullableColumn<string>;
  bar_position: NullableColumn<string>;
  pause: NullableColumn<boolean>;
  tempo: NullableColumn<string>;
  sticking_point_target: NullableColumn<string>;
  variation_key: NullableColumn<string>;
  pause_duration: NullableNumericColumn;
  deficit_height: NullableNumericColumn;
  block_height: NullableNumericColumn;
  rom_modifier: NullableColumn<string>;
  exercise_tier: NullableColumn<string>;
  fatigue_tier: NullableColumn<string>;
  overload_modality: NullableColumn<string>;
  required_equipment: NullableColumn<string[]>;
}

export interface PlansTable {
  id: Generated<string>;
  coach_id: NullableColumn<string>;
  trainee_id: string;
  name: string;
  start_date: string;
  end_date: string;
  plan_weeks: number;
  source: PlanSource;
  source_template_id: NullableColumn<string>;
  status: Generated<PlanStatus>;
  kind: Generated<PlanKind>;
  block_type: NullableColumn<BlockType>;
  mesocycle_phase: NullableColumn<MesocyclePhase>;
  training_max: NullableNumericColumn;
  tm_set_at: NullableColumn<Date>;
  published_at: NullableColumn<Date>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface PlanDaysTable {
  id: Generated<string>;
  plan_id: string;
  day_of_week: number;
  week_number: number;
  sort_order: Generated<number>;
}

export interface PlanDayCompletionsTable {
  id: Generated<string>;
  plan_day_id: string;
  student_id: string;
  source: PlanDayCompletionSource;
  completed_at: TimestampColumn;
}

export interface PlanDayShiftsTable {
  id: Generated<string>;
  plan_day_id: string;
  student_id: string;
  batch_id: string;
  // DATE-as-text in production; pg-mem returns a Date in integration tests.
  shifted_to_date: ColumnType<string | Date, string, string>;
  created_at: TimestampColumn;
}

export interface PlanExercisesTable {
  id: Generated<string>;
  plan_day_id: string;
  exercise_id: string;
  is_main_lift: Generated<boolean>;
  sort_order: Generated<number>;
  notes: NullableColumn<string>;
}

export interface PlanSetsTable {
  id: Generated<string>;
  plan_exercise_id: string;
  set_number: number;
  target_reps: number;
  target_reps_max: NullableColumn<number>;
  intensity_mode: IntensityMode;
  target_value: string;
  set_type: SetType;
  rest_seconds: number | null;
  coach_note: NullableColumn<string>;
  method_anchor: NullableColumn<MethodAnchor>;
  effort_method: NullableColumn<EffortMethod>;
  rpe_low: NullableColumn<number>;
  rpe_high: NullableColumn<number>;
  fatigue_pct_target: NullableNumericColumn;
  accommodating_tension: NullableColumn<boolean>;
  linear_increment: NullableNumericColumn;
  amrap_cap: NullableColumn<number>;
  backoff_pct: NullableNumericColumn;
  rir_target: NullableColumn<number>;
  rep_standard: NullableColumn<number>;
  set_scheme_hint: NullableJsonColumn<unknown>;
  volume_is_cap: NullableColumn<boolean>;
  pct_of_tm: NullableNumericColumn;
  intra_set_rest: NullableColumn<number>;
  load_mode: NullableColumn<string>;
  created_at: TimestampColumn;
}

export interface CoachProfilesTable {
  user_id: string;
  display_name: string;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface StudentProfilesTable {
  user_id: string;
  display_name: string;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface BindRequestsTable {
  id: Generated<string>;
  student_id: string;
  coach_id: string;
  status: Generated<BindRequestStatus>;
  submitted_at: TimestampColumn;
  responded_at: NullableColumn<Date>;
  expired_at: TimestampColumn;
  skip_evaluation: Generated<boolean>;
  rejection_silent: Generated<boolean>;
  invite_code_id: NullableColumn<string>;
  skip_reason: NullableColumn<string>;
}

export interface InviteCodesTable {
  id: Generated<string>;
  coach_id: string;
  code: string;
  type: InviteCodeType;
  max_uses: NullableColumn<number>;
  used_count: Generated<number>;
  expires_at: NullableColumn<Date>;
  revoked_at: NullableColumn<Date>;
  label: NullableColumn<string>;
  created_at: TimestampColumn;
}

export interface EvaluationPeriodsTable {
  id: Generated<string>;
  student_id: string;
  coach_id: string;
  bind_request_id: string;
  started_at: TimestampColumn;
  expected_end_at: Date;
  completed_at: NullableColumn<Date>;
  completion_type: NullableColumn<EvaluationCompletionType>;
}

export interface StudentEvaluationsTable {
  id: Generated<string>;
  student_id: string;
  coach_id: string;
  evaluation_period_id: NullableColumn<string>;
  overall_assessment: string;
  training_plan: string;
  words_to_student: NullableColumn<string>;
  first_saved_at: TimestampColumn;
  last_updated_at: TimestampColumn;
  is_active: Generated<boolean>;
}

export interface StudentEvaluationVersionsTable {
  id: Generated<string>;
  evaluation_id: string;
  overall_assessment: string;
  training_plan: string;
  words_to_student: NullableColumn<string>;
  notified_student: Generated<boolean>;
  saved_at: TimestampColumn;
}

export interface StudentOnboardingProfilesTable {
  user_id: string;
  unit_preference: NullableColumn<UnitPreference>;
  gender: NullableColumn<Gender>;
  birth_date: NullableColumn<string>;
  height_cm: NullableColumn<string>;
  weight_kg: NullableColumn<string>;
  training_years: NullableColumn<number>;
  squat_stance: NullableColumn<SquatStance>;
  deadlift_style: NullableColumn<DeadliftStyle>;
  bench_grip: NullableColumn<BenchGrip>;
  squat_1rm_kg: NullableColumn<string>;
  bench_1rm_kg: NullableColumn<string>;
  deadlift_1rm_kg: NullableColumn<string>;
  training_days: NullableColumn<TrainingDay[]>;
  gym_tier: NullableColumn<GymTier>;
  equipment_overrides: NullableColumn<string[]>;
  daily_life_intensity: NullableColumn<number>;
  life_stress: NullableColumn<number>;
  recovery_speed: NullableColumn<number>;
  sleep_hours: NullableColumn<number>;
  muscle_groups_to_strengthen: NullableColumn<MuscleGroup[]>;
  injury_notes: NullableColumn<string>;
  injury_areas: NullableColumn<InjuryArea[]>;
  is_competing: NullableColumn<boolean>;
  competition_date: NullableColumn<string>;
  target_weight_class: NullableColumn<string>;
  note_to_coach: NullableColumn<string>;
  completed_at: NullableColumn<Date>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface OnboardingUploadsTable {
  user_id: string;
  attachment_id: string;
  created_at: TimestampColumn;
}

export interface SetLogsTable {
  id: Generated<string>;
  student_id: string;
  plan_exercise_id: NullableColumn<string>;
  exercise_id: string;
  set_index: number;
  weight_kg: string;
  reps: number;
  rpe: NullableColumn<string>;
  coach_rpe: NullableColumn<string>;
  completed: Generated<boolean>;
  failed: Generated<boolean>;
  assumed: Generated<boolean>;
  adhoc: Generated<boolean>;
  actual_rir: NullableColumn<number>;
  accommodating_tension: NullableColumn<boolean>;
  e1rm_confidence: NullableColumn<E1rmConfidence>;
  mean_velocity: NullableNumericColumn;
  // DATE-as-text in prod (pool.ts OID 1082 parser); pg-mem hands back a Date.
  logged_date: string;
  logged_at: TimestampColumn;
}

export interface SessionReviewsTable {
  id: Generated<string>;
  student_id: string;
  // DATE-as-text (OID 1082 parser); pg-mem (tests) returns a Date — normalize at serialization.
  review_date: ColumnType<string | Date, string, string>;
  feeling: string;
  session_rpe: NullableColumn<string>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface MuscleFatigueEntry {
  muscle_group: ReadinessMuscleGroup;
  severity: number;
}

export interface ReadinessCheckinsTable {
  id: Generated<string>;
  student_id: string;
  // DATE-as-text (OID 1082 parser); pg-mem (tests) returns a Date — normalize at serialization.
  checkin_date: ColumnType<string | Date, string, string>;
  sleep_quality: number;
  mood: number;
  stress: number;
  // JSONB: insert as a JSON string (node-pg would otherwise encode a JS array as a
  // Postgres array literal); node-pg returns parsed JSON, pg-mem may return a string.
  muscle_fatigue: ColumnType<MuscleFatigueEntry[] | string, string, string>;
  motivation: NullableColumn<number>;
  energy: NullableColumn<number>;
  submitted_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface AthleteLiftStateTable {
  student_id: string;
  lift_family: LiftFamily;
  dev_stage: NullableColumn<DevStage>;
  method_anchor: NullableColumn<MethodAnchor>;
  seed_perf: NullableJsonColumn<unknown>;
  sticking_point_target: NullableColumn<string>;
  deadlift_stance: ColumnType<
    DeadliftStyle | null,
    DeadliftStyle | null | undefined,
    DeadliftStyle | null
  >;
}

export interface WaveTemplatesTable {
  wave_name: string;
  phase: MesocyclePhase;
  set_count: number;
  reps: number;
  pct_of_tm: NumericColumn;
  amrap_cap: NullableColumn<number>;
  rep_standard: NullableColumn<number>;
}

export interface AthleteCapacityProfilesTable {
  student_id: string;
  lift_family: LiftFamily;
  mev: NullableColumn<number>;
  mav: NullableColumn<number>;
  mrv: NullableColumn<number>;
  phase_scale: NullableJsonColumn<unknown>;
}

export interface VariationLogsTable {
  student_id: string;
  variation_key: string;
  last_used_week: NullableColumn<string>;
  best_e1rm: NullableNumericColumn;
}

export interface FeedbackTable {
  id: Generated<string>;
  coach_id: string;
  student_id: string;
  day_date: NullableColumn<string>;
  plan_exercise_id: NullableColumn<string>;
  video_id: NullableColumn<string>;
  text: string;
  posted_at: TimestampColumn;
  read_at: NullableColumn<Date>;
}

export interface AttachmentsTable {
  id: Generated<string>;
  owner_id: string;
  kind: AttachmentKind;
  oss_key: string;
  oss_upload_id: NullableColumn<string>;
  content_type: string;
  // BIGINT: node-pg returns int8 as string; pg-mem returns a number. Normalize at serialization.
  size_bytes: ColumnType<string | number, number, number>;
  filename: NullableColumn<string>;
  // set_video association (spec 007); SET NULL on log deletion.
  set_log_id: NullableColumn<string>;
  // Immutable source provenance for set_video visibility. Legacy rows with no
  // proof of origin remain null and are deliberately not coach-readable.
  source_plan_id: NullableColumn<string>;
  source_coach_id: NullableColumn<string>;
  is_unlinked_explicit: Generated<boolean>;
  part_count: number;
  actual_size_bytes: ColumnType<
    string | number | null,
    number | null | undefined,
    string | number | null
  >;
  status: Generated<AttachmentStatus>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface VideoMarkersTable {
  id: Generated<string>;
  video_id: string;
  coach_id: string;
  attachment_id: NullableColumn<string>;
  time_ms: number;
  level: Generated<VideoMarkerLevel>;
  note: Generated<string>;
  created_at: Generated<Date>;
}

export interface ConversationsTable {
  id: Generated<string>;
  coach_id: string;
  student_id: string;
  created_at: Generated<Date>;
  last_message_at: NullableColumn<Date>;
}

export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  // INTEGER intentionally stays a JS number on node-pg (chat wire contract).
  seq: number;
  sender_id: string;
  kind: 'text' | 'image';
  body: NullableColumn<string>;
  attachment_id: NullableColumn<string>;
  set_ref: NullableJsonColumn<SetRefV1>;
  video_id: NullableColumn<string>;
  client_id: string;
  created_at: Generated<Date>;
}

export interface ConversationReadsTable {
  conversation_id: string;
  user_id: string;
  // INTEGER intentionally stays a JS number on node-pg (chat wire contract).
  last_read_seq: number;
}

export interface NotificationOutboxTable {
  id: Generated<string>;
  event_type: string;
  aggregate_id: string;
  recipient_id: string;
  payload: ColumnType<unknown, string, unknown>;
  status: Generated<'pending' | 'delivered' | 'failed'>;
  attempt_count: Generated<number>;
  last_error: NullableColumn<string>;
  created_at: TimestampColumn;
  delivered_at: NullableColumn<Date>;
}

export interface DeviceTokensTable {
  id: Generated<string>;
  user_id: string;
  token: string;
  platform: 'ios';
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
  last_seen_at: TimestampColumn;
}

export interface TrainingSessionsTable {
  id: Generated<string>;
  student_id: string;
  // DATE-as-text in production; pg-mem returns a Date in integration tests.
  session_date: ColumnType<string | Date, string, string>;
  status: SessionStatus;
  started_at: TimestampColumn;
  last_set_at: TimestampColumn;
  completed_at: NullableColumn<Date>;
  plan_day_ids: Generated<string[]>;
  archived_sets_logged: NullableColumn<number>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface StudentEventsTable {
  id: Generated<string>;
  student_id: string;
  coach_id: NullableColumn<string>;
  event_type: StudentEventType;
  // DATE-as-text in production; pg-mem returns a Date in integration tests.
  session_date: ColumnType<string | Date, string, string>;
  occurred_at: TimestampColumn;
  payload: ColumnType<
    Record<string, unknown> | string,
    Record<string, unknown> | string | undefined
  >;
  dedup_key: string;
  created_at: TimestampColumn;
}

export interface StudentSignalsTable {
  id: Generated<string>;
  student_id: string;
  coach_id: string;
  signal_type: SignalType;
  severity: SignalSeverity;
  status: SignalStatus;
  reason: string;
  payload: ColumnType<
    Record<string, unknown> | string,
    Record<string, unknown> | string | undefined
  >;
  opened_at: TimestampColumn;
  acked_at: NullableColumn<Date>;
  resolved_at: NullableColumn<Date>;
  expires_at: NullableColumn<Date>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

// name's authoritative enum lives in the route's zod discriminatedUnion; the
// column is plain text for forward-compat (SPEC 008 §6).
export interface EventsTable {
  // BIGSERIAL — node-pg reads int8 as string (same convention as attachments
  // size_bytes); timeline queries never select id.
  id: Generated<string>;
  event_id: string; // client uuid, UNIQUE
  anon_id: string;
  user_id: NullableColumn<string>; // server-derived, NULL pre-login, ON DELETE SET NULL
  role: NullableColumn<string>;
  session_id: string;
  seq: number;
  name: string;
  // JSONB: insert a JSON string (node-pg would otherwise encode a JS object oddly);
  // node-pg reads parsed JSON, pg-mem may return a string. Normalize at serialize.
  props: ColumnType<Record<string, unknown> | string, string, string>;
  schema_version: Generated<number>;
  app_version: NullableColumn<string>;
  build: NullableColumn<string>;
  platform: Generated<EventPlatform>;
  ts_client: TimestampColumn;
  ts_server: TimestampColumn;
}

// The ONE free-text path (SPEC 008 §4b). Physically separate from events; text
// is the only free-text column in the analytics surface.
export interface AnalyticsFeedbackTable {
  id: Generated<string>;
  event_id: string; // = the friction_feedback signal event's id (join key), UNIQUE
  anon_id: string;
  user_id: NullableColumn<string>;
  session_id: string;
  flow: string;
  from_screen: string;
  trigger: string;
  text: string;
  app_version: NullableColumn<string>;
  build: NullableColumn<string>;
  ts_client: TimestampColumn;
  ts_server: TimestampColumn;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  exercises: ExercisesTable;
  plans: PlansTable;
  plan_days: PlanDaysTable;
  plan_day_completions: PlanDayCompletionsTable;
  plan_day_shifts: PlanDayShiftsTable;
  plan_exercises: PlanExercisesTable;
  plan_sets: PlanSetsTable;
  coach_profiles: CoachProfilesTable;
  student_profiles: StudentProfilesTable;
  bind_requests: BindRequestsTable;
  set_logs: SetLogsTable;
  session_reviews: SessionReviewsTable;
  readiness_checkins: ReadinessCheckinsTable;
  feedback: FeedbackTable;
  invite_codes: InviteCodesTable;
  evaluation_periods: EvaluationPeriodsTable;
  student_evaluations: StudentEvaluationsTable;
  student_evaluation_versions: StudentEvaluationVersionsTable;
  student_onboarding_profiles: StudentOnboardingProfilesTable;
  onboarding_uploads: OnboardingUploadsTable;
  attachments: AttachmentsTable;
  video_markers: VideoMarkersTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  conversation_reads: ConversationReadsTable;
  notification_outbox: NotificationOutboxTable;
  device_tokens: DeviceTokensTable;
  training_sessions: TrainingSessionsTable;
  student_events: StudentEventsTable;
  student_signals: StudentSignalsTable;
  athlete_lift_state: AthleteLiftStateTable;
  wave_templates: WaveTemplatesTable;
  athlete_capacity_profiles: AthleteCapacityProfilesTable;
  variation_logs: VariationLogsTable;
  events: EventsTable;
  analytics_feedback: AnalyticsFeedbackTable;
}
