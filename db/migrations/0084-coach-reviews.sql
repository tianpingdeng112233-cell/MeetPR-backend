-- Spec 063: independent coach directory and reviews. Additive only.
CREATE TABLE coach_review_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL UNIQUE,
  nickname TEXT CHECK (length(nickname) BETWEEN 2 AND 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE listed_coaches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  nickname TEXT NOT NULL,
  gender TEXT NOT NULL,
  douyin_handle TEXT NOT NULL UNIQUE CHECK (douyin_handle = lower(trim(douyin_handle))),
  douyin_url TEXT NOT NULL,
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  gyms TEXT[] NOT NULL,
  teaching_mode TEXT NOT NULL CHECK (teaching_mode IN ('线下', '线上', '线上+线下')),
  best_total_kg NUMERIC,
  competition_class TEXT,
  equipment TEXT CHECK (equipment IS NULL OR equipment IN ('无装备', '单层装备', '多层装备')),
  certifications TEXT,
  coaching_years NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden','rejected')),
  rejection_reason TEXT,
  submitted_by UUID REFERENCES coach_review_accounts(id),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX listed_coaches_status_idx ON listed_coaches(status);

CREATE TABLE coach_review_otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT,
  expires_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  day TEXT NOT NULL,
  daily_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE coach_review_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES coach_review_accounts(id),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX coach_review_tokens_expiry_idx ON coach_review_tokens(expires_at);

CREATE TABLE coach_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listed_coach_id UUID NOT NULL REFERENCES listed_coaches(id),
  account_id UUID NOT NULL REFERENCES coach_review_accounts(id),
  overall INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 5),
  professionalism INTEGER NOT NULL CHECK (professionalism BETWEEN 1 AND 5),
  communication INTEGER NOT NULL CHECK (communication BETWEEN 1 AND 5),
  results INTEGER NOT NULL CHECK (results BETWEEN 1 AND 5),
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 10 AND 1000),
  edited BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX coach_reviews_active_unique ON coach_reviews(listed_coach_id,account_id) WHERE deleted_at IS NULL;
CREATE INDEX coach_reviews_coach_idx ON coach_reviews(listed_coach_id,updated_at);
CREATE TABLE coach_review_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word TEXT NOT NULL UNIQUE CHECK (length(word) BETWEEN 1 AND 100)
);

CREATE TABLE coach_review_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES coach_reviews(id),
  account_id UUID NOT NULL REFERENCES coach_review_accounts(id),
  reason TEXT NOT NULL CHECK (reason IN ('abuse','privacy','advertising','other')),
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  decision TEXT CHECK (decision IS NULL OR decision IN ('keep','delete')),
  decided_by UUID,
  UNIQUE(review_id,account_id)
);
CREATE INDEX coach_review_reports_queue_idx ON coach_review_reports(closed_at,created_at);
