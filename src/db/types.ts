import type { ColumnType, Generated } from 'kysely';

export const USER_ROLES = ['coach', 'coached_student', 'self_train_student'] as const;
export const LIFT_FAMILIES = ['squat', 'bench', 'deadlift'] as const;
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
export const DEADLIFT_STYLES = ['conventional', 'sumo'] as const;
export const BENCH_GRIPS = ['narrow', 'standard', 'wide'] as const;
export const GYM_TIERS = ['home_with_rack', 'commercial', 'professional'] as const;
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
export const ATTACHMENT_KINDS = ['set_video', 'onboarding_video', 'onboarding_doc'] as const;
export const ATTACHMENT_STATUSES = [
  'uploading',
  'completing',
  'aborting',
  'ready',
  'aborted',
] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type LiftFamily = (typeof LIFT_FAMILIES)[number];
export type ExerciseType = (typeof EXERCISE_TYPES)[number];
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];
export type Equipment = (typeof EQUIPMENT)[number];
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];
export type PlanSource = (typeof PLAN_SOURCES)[number];
export type ApiPlanSource = (typeof API_PLAN_SOURCES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
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
export type TrainingDay = (typeof TRAINING_DAYS)[number];
export type InjuryArea = (typeof INJURY_AREAS)[number];
export type ReadinessMuscleGroup = (typeof READINESS_MUSCLE_GROUPS)[number];
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

type NullableColumn<T> = ColumnType<T | null, T | null | undefined, T | null>;
type TimestampColumn = ColumnType<Date, Date | undefined, Date>;

export interface UsersTable {
  id: Generated<string>;
  phone: string;
  apple_user_id: NullableColumn<string>;
  password_hash: string;
  role: UserRole;
  refresh_token_jti: NullableColumn<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExercisesTable {
  id: Generated<string>;
  name: string;
  name_en: NullableColumn<string>;
  exercise_type: ExerciseType;
  main_lift_family: NullableColumn<LiftFamily>;
  is_competition_lift: Generated<boolean>;
  muscle_groups: MuscleGroup[];
  equipment: Equipment[];
  movement_pattern: Generated<MovementPattern[]>;
  created_by_coach_id: NullableColumn<string>;
  created_at: TimestampColumn;
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
  plan_exercise_id: string;
  set_index: number;
  weight_kg: string;
  reps: number;
  rpe: NullableColumn<string>;
  completed: Generated<boolean>;
  failed: Generated<boolean>;
  logged_at: TimestampColumn;
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
  submitted_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface FeedbackTable {
  id: Generated<string>;
  coach_id: string;
  student_id: string;
  day_date: NullableColumn<string>;
  plan_exercise_id: NullableColumn<string>;
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
  status: Generated<AttachmentStatus>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface Database {
  users: UsersTable;
  exercises: ExercisesTable;
  plans: PlansTable;
  plan_days: PlanDaysTable;
  plan_exercises: PlanExercisesTable;
  plan_sets: PlanSetsTable;
  coach_profiles: CoachProfilesTable;
  student_profiles: StudentProfilesTable;
  bind_requests: BindRequestsTable;
  set_logs: SetLogsTable;
  readiness_checkins: ReadinessCheckinsTable;
  feedback: FeedbackTable;
  invite_codes: InviteCodesTable;
  evaluation_periods: EvaluationPeriodsTable;
  student_evaluations: StudentEvaluationsTable;
  student_evaluation_versions: StudentEvaluationVersionsTable;
  student_onboarding_profiles: StudentOnboardingProfilesTable;
  onboarding_uploads: OnboardingUploadsTable;
  attachments: AttachmentsTable;
}
