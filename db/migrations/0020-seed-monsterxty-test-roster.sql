-- Migration 0020: seed the MonsterXTY internal-test roster (1 coach + 5 unbound students).
-- For TestFlight internal testing (2026-06-24).
--
-- Students are NOT pre-bound: binding goes through the normal in-app flow — the coach
-- (MonsterXTY) generates an invite code, each student enters it, the coach accepts, and
-- the coach can rename students afterwards. Display names are generic 学员1..5 by design.
--
-- Deploy note: password_hash is a sentinel. After applying this migration, set real bcrypt
-- hashes via a post-deploy psql UPDATE (see template at the bottom of this file). Do NOT
-- commit real password hashes.
--
-- Idempotent: ON CONFLICT (phone)/(user_id) DO NOTHING — safe to re-run.

BEGIN;

-- Coach: MonsterXTY
INSERT INTO users (id, phone, password_hash, role, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000020', '+8613800000010', 'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY', 'coach', now(), now())
ON CONFLICT (phone) DO NOTHING;

INSERT INTO coach_profiles (user_id, display_name) VALUES
  ('00000000-0000-0000-0000-000000000020', 'MonsterXTY')
ON CONFLICT (user_id) DO NOTHING;

-- Students 学员1..5 (unbound; bound later via the coach's invite code, then renamable)
INSERT INTO users (id, phone, password_hash, role, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000021', '+8613800000011', 'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY', 'coached_student', now(), now()),
  ('00000000-0000-0000-0000-000000000022', '+8613800000012', 'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY', 'coached_student', now(), now()),
  ('00000000-0000-0000-0000-000000000023', '+8613800000013', 'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY', 'coached_student', now(), now()),
  ('00000000-0000-0000-0000-000000000024', '+8613800000014', 'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY', 'coached_student', now(), now()),
  ('00000000-0000-0000-0000-000000000025', '+8613800000015', 'REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY', 'coached_student', now(), now())
ON CONFLICT (phone) DO NOTHING;

INSERT INTO student_profiles (user_id, display_name) VALUES
  ('00000000-0000-0000-0000-000000000021', '学员1'),
  ('00000000-0000-0000-0000-000000000022', '学员2'),
  ('00000000-0000-0000-0000-000000000023', '学员3'),
  ('00000000-0000-0000-0000-000000000024', '学员4'),
  ('00000000-0000-0000-0000-000000000025', '学员5')
ON CONFLICT (user_id) DO NOTHING;

COMMIT;

-- ============================================================================
-- POST-DEPLOY (run manually; do NOT commit real hashes):
--
--   1) Generate ONE bcrypt hash from your chosen test password (run in the backend
--      project so it uses the same bcrypt lib; pick the password yourself, store it
--      in your password manager — do not share it):
--        node -e "console.log(require('bcrypt').hashSync(process.argv[1],10))" 'YOUR_TEST_PASSWORD'
--
--   2) Apply that hash to all 6 accounts (same hash = same password for every test login):
--        UPDATE users SET password_hash = '<paste-bcrypt-hash>'
--        WHERE phone IN (
--          '+8613800000010','+8613800000011','+8613800000012',
--          '+8613800000013','+8613800000014','+8613800000015'
--        );
-- ============================================================================
