-- Migration 0004: seed V0.1 internal testing users and accepted bond.
-- Spec: specs/003-student-actions/SPEC.md
-- Deploy note: replace password sentinels with real bcrypt hashes via post-migration psql UPDATE.

BEGIN;

INSERT INTO users (id, phone, password_hash, role, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '+8613800000001',
  'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY',
  'coach',
  now(), now()
) ON CONFLICT (phone) DO NOTHING;

INSERT INTO users (id, phone, password_hash, role, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '+8613800000002',
  'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY',
  'coached_student',
  now(), now()
) ON CONFLICT (phone) DO NOTHING;

INSERT INTO coach_profiles (user_id, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'David(内测教练)')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO student_profiles (user_id, display_name)
VALUES ('00000000-0000-0000-0000-000000000002', 'xty(内测学员)')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO bind_requests (
  id, student_id, coach_id, status, submitted_at, responded_at,
  expired_at, skip_evaluation, rejection_silent
)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'accepted', now(), now(),
  now() + interval '7 days',
  TRUE,
  TRUE
)
ON CONFLICT DO NOTHING;

COMMIT;
