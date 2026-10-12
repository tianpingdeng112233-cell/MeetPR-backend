-- 教练主页、订阅到期日与招生申请。
-- 纯新增表与可空列，不修改现有列或存量行，不回填。
-- 回滚（须先备份新数据）：DROP TABLE coach_enquiries; DROP TABLE coach_pages;
-- ALTER TABLE coach_profiles DROP COLUMN subscription_expires_at;
BEGIN;
SET search_path TO public;

ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS coach_pages (
  coach_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT UNIQUE,
  headline TEXT NOT NULL DEFAULT '' CHECK (length(headline) <= 30),
  bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 500),
  specialties TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'published', 'hidden', 'suspended')),
  listed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  changes_pending_review BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_pages_listed_idx ON coach_pages (listed_at);

CREATE TABLE IF NOT EXISTS coach_enquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  contact TEXT NOT NULL CHECK (length(contact) BETWEEN 1 AND 100),
  squat_kg NUMERIC CHECK (squat_kg BETWEEN 0 AND 600),
  bench_kg NUMERIC CHECK (bench_kg BETWEEN 0 AND 600),
  deadlift_kg NUMERIC CHECK (deadlift_kg BETWEEN 0 AND 600),
  goal TEXT NOT NULL DEFAULT '' CHECK (length(goal) <= 500),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  source_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_enquiries_coach_created_idx ON coach_enquiries (coach_id, created_at);
CREATE INDEX IF NOT EXISTS coach_enquiries_quota_idx ON coach_enquiries (coach_id, source_hash, created_at);
COMMIT;
