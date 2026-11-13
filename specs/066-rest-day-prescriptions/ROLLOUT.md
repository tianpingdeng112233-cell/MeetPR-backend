# CN rollout — rest-day prescriptions

Status: prepared; production migration and gate change NOT executed. No Global deployment.

## Candidate and ordering

- Web spec 028 + backend spec 066. Merge exact reviewed PRs after CI; build web from the latest `main` including weight-warning PR 165. Copy its `dist/` into backend `web/` and verify hashes before backend PR merge.
- Reserve migration `0087-plan-day-rest.sql`; immediately before application recheck `origin/staging`, open PRs and the applied ledger. Integrated remote staging is fe93336 (video alignment, including weight-warning assets); schema head is 0086. Recheck these values at the actual deployment gate. 0084's unrelated gate remains off.
- David approves this additive production migration explicitly under global AGENTS. Apply through the established DMS/manual channel to CN RDS `meetpr`, schema `public`. Before applying, run the repository backup procedure (`pnpm tsx scripts/backup-db.ts`) through the approved credential channel; verify a non-empty backup and record its path without exposing credentials. No data deletion, ID remap or rewrite.

## Reviewable migration

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE public.plan_days ADD COLUMN is_rest BOOLEAN NOT NULL DEFAULT FALSE;
COMMIT;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'plan_days' AND column_name = 'is_rest';
SELECT count(*) AS rest_days FROM public.plan_days WHERE is_rest = TRUE;
```

Expected: one boolean NOT NULL column, default false; rest count zero before activation. Existing day/exercise/set IDs and shifts are untouched. If lock timeout occurs, transaction rolls back; retry only after resolving the blocker. Do not use IF NOT EXISTS to conceal a mismatched pre-existing schema.

## Deployment and verification

1. Record schema evidence in `db/MIGRATIONS-APPLIED.md` and this card's journal.
2. Merge backend containing the reviewed source and exact latest web bundle; wait for CI and `build-push-staging.yml` for that exact SHA.
3. Dispatch `deploy-staging.yml` with full `image_sha` and `migrations_applied=true` only after step 1. Initially leave `PLAN_REST_DAYS_ENABLED` absent/false. Verify health and old student/default GET compatibility.
4. Set SAE `PLAN_REST_DAYS_ENABLED=true`, preserving every other environment setting. Verify the exact backend image and opted-in owning-coach capability.
5. On the authorized test coach's disposable plan: training→rest→save→reload→training. Verify identical day/exercise/set IDs for pure switches, notes/opaque sets/shift dates retained, student GET omits rest, empty training delivery blocks, logged days cannot switch. Never modify a real user's plan for smoke.
6. Verify served HTML/JS/CSS byte hashes against the built files; complete journal, spec acceptance and release ledger.

## Rollback

Disable `PLAN_REST_DAYS_ENABLED` to prevent new type changes. Keep the column, prescriptions and rest-aware backend reads. Do not deploy a pre-feature backend after any rests exist: it would expose retained prescriptions to students. If a source rollback is required, use the reviewed rest-aware build with the flag off; restoring rests to training requires a separately approved concrete data plan. Never drop the column as rollback.
