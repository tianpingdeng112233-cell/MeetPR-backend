BEGIN;
SET search_path TO public;

ALTER TABLE plan_sets ADD COLUMN pct_anchor TEXT;

-- load_mode IS NOT NULL is load-bearing: without it, load_mode = 'pct' evaluates
-- to UNKNOWN on NULL rows and the CHECK would silently pass a non-pct anchor.
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_pct_anchor_check CHECK (
  pct_anchor IS NULL OR
  (pct_anchor IN ('one_rm', 'e1rm', 'top_set') AND load_mode IS NOT NULL AND load_mode = 'pct')
);

COMMIT;

-- Rollback (staging drills only):
--   BEGIN;
--   ALTER TABLE plan_sets DROP CONSTRAINT plan_sets_pct_anchor_check;
--   ALTER TABLE plan_sets DROP COLUMN pct_anchor;
--   COMMIT;
