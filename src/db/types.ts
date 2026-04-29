import type { ColumnType, Generated } from 'kysely';

export const USER_ROLES = ['coach', 'coached_student', 'self_train_student'] as const;

export type UserRole = (typeof USER_ROLES)[number];

type NullableColumn<T> = ColumnType<T | null, T | null | undefined, T | null>;

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

export interface Database {
  users: UsersTable;
  // coach_profiles: CoachProfilesTable;
  // student_profiles: StudentProfilesTable;
  // training_plans: TrainingPlansTable;
  // ...
}
