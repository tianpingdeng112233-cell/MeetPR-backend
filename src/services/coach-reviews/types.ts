import type { ColumnType, Generated } from 'kysely';
export interface ListedCoachesTable {
  id: Generated<string>;
  name: string;
  nickname: string;
  gender: string;
  douyin_handle: string;
  douyin_url: string;
  province: string;
  city: string;
  gyms: string[];
  teaching_mode: '线下' | '线上' | '线上+线下';
  best_total_kg: ColumnType<number | string | null, number | null, number | null>;
  competition_class: string | null;
  equipment: '无装备' | '单层装备' | '多层装备' | null;
  certifications: string | null;
  coaching_years: ColumnType<number | string | null, number | null, number | null>;
  status: Generated<'pending' | 'published' | 'hidden' | 'rejected'>;
  rejection_reason: Generated<string | null>;
  submitted_by: Generated<string | null>;
  reviewed_by: Generated<string | null>;
  reviewed_at: Generated<Date | null>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}
export interface CoachReviewAccountsTable {
  id: Generated<string>;
  phone: string;
  nickname: Generated<string | null>;
  created_at: Generated<Date>;
}
export interface CoachReviewOtpsTable {
  phone: string;
  code_hash: Generated<string | null>;
  expires_at: Generated<Date | null>;
  last_sent_at: Generated<Date | null>;
  day: string;
  daily_count: Generated<number>;
  attempts: Generated<number>;
}
export interface CoachReviewTokensTable {
  token_hash: string;
  account_id: string;
  expires_at: Date;
}
export interface CoachReviewsTable {
  id: Generated<string>;
  listed_coach_id: string;
  account_id: string;
  overall: number;
  professionalism: number;
  communication: number;
  results: number;
  value: number;
  body: string;
  edited: Generated<boolean>;
  deleted_at: Generated<Date | null>;
  deleted_by: Generated<string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface CoachReviewWordsTable {
  id: Generated<string>;
  word: string;
}
export interface CoachReviewReportsTable {
  id: Generated<string>;
  review_id: string;
  account_id: string;
  reason: 'abuse' | 'privacy' | 'advertising' | 'other';
  explanation: string | null;
  created_at: Generated<Date>;
  closed_at: Generated<Date | null>;
  decision: Generated<'keep' | 'delete' | null>;
  decided_by: Generated<string | null>;
}
