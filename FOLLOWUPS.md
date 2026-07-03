# FOLLOWUPS

Longer-horizon follow-ups not tied to a single in-flight spec. **Check each against the code before acting — several items here already shipped and were only discovered stale on audit.** When you close one, move it to Done with the migration / PR that resolved it; the Done list is the audit trail, so resolve-by-moving, not resolve-by-deleting.

## Open

- [ ] Wire SSL config for Aliyun RDS connection (set `?sslmode=require` in prod DSN; ADR 004 §6 deadline: pre-Stage-2) — in-flight in PR #15, not yet merged
- [ ] Narrow RDS firewall whitelist from `0.0.0.0/0` to deploy IP (ADR 004 §6 blocker)
- [ ] Enforce coach↔trainee binding in `POST /plans`. Current state: the handler only checks the trainee exists and holds a student role (`src/routes/plans/index.ts`, the `TRAINEE_NOT_FOUND` guard) — it does **not** require an accepted bond, so a coach can create a plan for an unbound student. `hasAcceptedBond` (`src/db/bonds.ts`, already used by `evaluations.ts` / `readiness.ts`) is the ready-made check to reuse.
- [ ] Add multi-device refresh tracking with a dedicated `refresh_tokens` table
- [ ] Add `week_templates` + materialization spec; validate `source_template_id` and add `POST /plans/from-template`
- [ ] Add `progression_rule_groups`, `progression_rule_assignments`, and `exercise_week_overrides` migration + endpoints
- [ ] Add self-train student plan creation path with `plans.coach_id IS NULL`
- [ ] Replace `notifyPlanPublished` stub with Aliyun-MNS / APNs bridge once the V1.5 realtime spec lands
- [ ] Add `GET /exercises/:id` if iOS needs single-exercise lookup outside the bulk catalog
- [ ] Decide coach-deletion policy for `plans.coach_id` (`RESTRICT`) and `exercises.created_by_coach_id` (`SET NULL`)
- [ ] Decide between hand-rolled `Database` types and `kysely-codegen` — the schema has now crossed the ~10-table threshold that was the original trigger
- [ ] Stand up docker-compose for local Postgres 17 once integration tests need a real DB
- [ ] Add a `db.test.ts` integration suite when the first real query lands (will need a service container in CI)
- [ ] Revisit JWT algorithm (HS256 → RS256) if a second verifier appears (e.g. admin web app)

## Done

- [x] Bootstrap repo scaffold (specs/000-bootstrap)
- [x] First migration: define `users` table; augment `Database` type in `src/db/types.ts` (specs/001-auth)
- [x] `coach_profiles` migration + `Database` type augment — landed in `0003.5-init-profile-tables.sql` + `src/db/types.ts`
- [x] `student_profiles` migration + `Database` type augment — landed in `0003.5-init-profile-tables.sql` + `src/db/types.ts`
- [x] `bind_requests` / `invite_codes` migrations — landed in `0003.6-init-bind-requests.sql`, `0009-extend-bind-requests.sql`, and `0008-init-invite-codes.sql`. (The `POST /plans` binding-enforcement half of the original item is still open — split out above.)
- [x] Onboarding / profile fields on `users` (`name`, `gender`, `birth_date`, `height_cm`, `weight_kg`, `unit_system`) — landed via `0013-init-onboarding-profiles.sql` + `0003.5-init-profile-tables.sql`. Note: `avatar_url` was never implemented (dropped from scope).
