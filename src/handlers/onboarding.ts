import type { Insertable, Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { sql } from 'kysely';

import type { Database, StudentOnboardingProfilesTable } from '../db/types';
import { dateOnly, decimal, timestamp } from './serialization';

type DbExecutor = Kysely<Database> | Transaction<Database>;
type OnboardingRow = Selectable<StudentOnboardingProfilesTable>;

/** Product columns writable through PUT /students/me/onboarding. */
export const ONBOARDING_FIELDS = [
  'unit_preference',
  'gender',
  'birth_date',
  'height_cm',
  'weight_kg',
  'training_years',
  'squat_stance',
  'deadlift_style',
  'bench_grip',
  'squat_1rm_kg',
  'bench_1rm_kg',
  'deadlift_1rm_kg',
  'training_days',
  'gym_tier',
  'equipment_overrides',
  'daily_life_intensity',
  'life_stress',
  'recovery_speed',
  'sleep_hours',
  'muscle_groups_to_strengthen',
  'injury_notes',
  'injury_areas',
  'is_competing',
  'competition_date',
  'target_weight_class',
  'note_to_coach',
] as const;

export type OnboardingField = (typeof ONBOARDING_FIELDS)[number];

export const ONE_RM_FIELDS = ['squat_1rm_kg', 'bench_1rm_kg', 'deadlift_1rm_kg'] as const;

/** Required before POST /students/me/onboarding/complete succeeds. */
const REQUIRED_FOR_COMPLETION = [
  'unit_preference',
  'gender',
  'birth_date',
  'height_cm',
  'weight_kg',
  'training_years',
  'squat_stance',
  'deadlift_style',
  'squat_1rm_kg',
  'bench_1rm_kg',
  'deadlift_1rm_kg',
  'training_days',
  'gym_tier',
  'daily_life_intensity',
  'life_stress',
  'recovery_speed',
  'sleep_hours',
  'is_competing',
] as const satisfies readonly OnboardingField[];

export type OnboardingPatch = Partial<
  Pick<Updateable<StudentOnboardingProfilesTable>, OnboardingField>
>;

export interface OnboardingProfileResponse {
  user_id: string;
  unit_preference: OnboardingRow['unit_preference'];
  gender: OnboardingRow['gender'];
  birth_date: string | null;
  height_cm: string | null;
  weight_kg: string | null;
  training_years: number | null;
  squat_stance: OnboardingRow['squat_stance'];
  deadlift_style: OnboardingRow['deadlift_style'];
  bench_grip: OnboardingRow['bench_grip'];
  squat_1rm_kg: string | null;
  bench_1rm_kg: string | null;
  deadlift_1rm_kg: string | null;
  training_days: OnboardingRow['training_days'];
  gym_tier: OnboardingRow['gym_tier'];
  equipment_overrides: string[] | null;
  daily_life_intensity: number | null;
  life_stress: number | null;
  recovery_speed: number | null;
  sleep_hours: number | null;
  muscle_groups_to_strengthen: OnboardingRow['muscle_groups_to_strengthen'];
  injury_notes: string | null;
  injury_areas: OnboardingRow['injury_areas'];
  is_competing: boolean | null;
  competition_date: string | null;
  target_weight_class: string | null;
  note_to_coach: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  upload_attachment_ids: string[];
}

function toOnboardingProfile(
  row: OnboardingRow,
  uploadAttachmentIds: string[],
): OnboardingProfileResponse {
  return {
    user_id: row.user_id,
    unit_preference: row.unit_preference,
    gender: row.gender,
    birth_date: dateOnly(row.birth_date),
    height_cm: decimal(row.height_cm, 1),
    weight_kg: decimal(row.weight_kg, 2),
    training_years: row.training_years,
    squat_stance: row.squat_stance,
    deadlift_style: row.deadlift_style,
    bench_grip: row.bench_grip,
    squat_1rm_kg: decimal(row.squat_1rm_kg, 2),
    bench_1rm_kg: decimal(row.bench_1rm_kg, 2),
    deadlift_1rm_kg: decimal(row.deadlift_1rm_kg, 2),
    training_days: row.training_days,
    gym_tier: row.gym_tier,
    equipment_overrides: row.equipment_overrides,
    daily_life_intensity: row.daily_life_intensity,
    life_stress: row.life_stress,
    recovery_speed: row.recovery_speed,
    sleep_hours: row.sleep_hours,
    muscle_groups_to_strengthen: row.muscle_groups_to_strengthen,
    injury_notes: row.injury_notes,
    injury_areas: row.injury_areas,
    is_competing: row.is_competing,
    competition_date: dateOnly(row.competition_date),
    target_weight_class: row.target_weight_class,
    note_to_coach: row.note_to_coach,
    completed_at: row.completed_at === null ? null : timestamp(row.completed_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    upload_attachment_ids: uploadAttachmentIds,
  };
}

async function fetchUploadIds(db: DbExecutor, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('onboarding_uploads')
    .select(['attachment_id'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((row) => row.attachment_id);
}

export type UpsertOnboardingResult =
  | { type: 'updated'; profile: OnboardingProfileResponse }
  | { type: 'one-rm-locked' };

/**
 * Step-by-step re-entrant upsert. Only the submitted fields are written.
 * Once completed_at is set, the three 1RM fields are student-locked
 * (403 ONE_RM_LOCKED) — coach endpoint is the only writer (spec 005 E).
 */
export async function upsertOnboardingProfile(
  db: Kysely<Database>,
  userId: string,
  patch: OnboardingPatch,
  uploadAttachmentIds: string[] | undefined,
): Promise<UpsertOnboardingResult> {
  return db.transaction().execute(async (trx): Promise<UpsertOnboardingResult> => {
    const touchesOneRm = ONE_RM_FIELDS.some((field) => field in patch);
    if (touchesOneRm) {
      const existing = await trx
        .selectFrom('student_onboarding_profiles')
        .select(['completed_at'])
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (existing && existing.completed_at !== null) {
        return { type: 'one-rm-locked' };
      }
    }

    const insertValues: Insertable<StudentOnboardingProfilesTable> = {
      user_id: userId,
      ...patch,
    };
    const row = await trx
      .insertInto('student_onboarding_profiles')
      .values(insertValues)
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ ...patch, updated_at: sql<Date>`now()` }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    if (uploadAttachmentIds !== undefined) {
      // Full-replace semantics for Step-6 uploads (spec 005 D17).
      await trx.deleteFrom('onboarding_uploads').where('user_id', '=', userId).execute();
      if (uploadAttachmentIds.length > 0) {
        await trx
          .insertInto('onboarding_uploads')
          .values(
            uploadAttachmentIds.map((attachmentId) => ({
              user_id: userId,
              attachment_id: attachmentId,
            })),
          )
          .execute();
      }
    }

    return {
      type: 'updated',
      profile: toOnboardingProfile(row, await fetchUploadIds(trx, userId)),
    };
  });
}

export type CompleteOnboardingResult =
  | { type: 'completed'; profile: OnboardingProfileResponse }
  | { type: 'incomplete'; missingFields: string[] };

/**
 * Server-side required-field gate for the 7-step wizard. Idempotent:
 * re-completing keeps the original completed_at.
 */
export async function completeOnboardingProfile(
  db: Kysely<Database>,
  userId: string,
): Promise<CompleteOnboardingResult> {
  return db.transaction().execute(async (trx): Promise<CompleteOnboardingResult> => {
    const row = await trx
      .selectFrom('student_onboarding_profiles')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();

    if (!row) {
      return {
        type: 'incomplete',
        missingFields: [...REQUIRED_FOR_COMPLETION],
      };
    }

    const missing: string[] = REQUIRED_FOR_COMPLETION.filter((field) => row[field] === null);
    // competition_date is conditionally required (is_competing = true).
    if (row.is_competing === true && row.competition_date === null) {
      missing.push('competition_date');
    }
    if (missing.length > 0) {
      return { type: 'incomplete', missingFields: missing };
    }

    if (row.completed_at !== null) {
      return {
        type: 'completed',
        profile: toOnboardingProfile(row, await fetchUploadIds(trx, userId)),
      };
    }

    const updated = await trx
      .updateTable('student_onboarding_profiles')
      .set({ completed_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      type: 'completed',
      profile: toOnboardingProfile(updated, await fetchUploadIds(trx, userId)),
    };
  });
}

export async function fetchOnboardingProfile(
  db: Kysely<Database>,
  userId: string,
): Promise<OnboardingProfileResponse | null> {
  const row = await db
    .selectFrom('student_onboarding_profiles')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!row) return null;
  return toOnboardingProfile(row, await fetchUploadIds(db, userId));
}

export interface OneRmPatch {
  squat_1rm_kg?: string | undefined;
  bench_1rm_kg?: string | undefined;
  deadlift_1rm_kg?: string | undefined;
}

export interface OneRmResponse {
  squat_1rm_kg: string | null;
  bench_1rm_kg: string | null;
  deadlift_1rm_kg: string | null;
  updated_at: string;
}

/**
 * Coach-only 1RM writer — the sole mutation path once the student's
 * onboarding is completed (1RM lock, spec 005 E). Upserts the row so a coach
 * can seed 1RMs even before the student finished the wizard.
 */
export async function setStudentOneRm(
  db: Kysely<Database>,
  studentId: string,
  patch: OneRmPatch,
): Promise<OneRmResponse> {
  const row = await db
    .insertInto('student_onboarding_profiles')
    .values({ user_id: studentId, ...patch })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ ...patch, updated_at: sql<Date>`now()` }),
    )
    .returning(['squat_1rm_kg', 'bench_1rm_kg', 'deadlift_1rm_kg', 'updated_at'])
    .executeTakeFirstOrThrow();

  return {
    squat_1rm_kg: decimal(row.squat_1rm_kg, 2),
    bench_1rm_kg: decimal(row.bench_1rm_kg, 2),
    deadlift_1rm_kg: decimal(row.deadlift_1rm_kg, 2),
    updated_at: timestamp(row.updated_at),
  };
}
