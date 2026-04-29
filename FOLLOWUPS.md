# FOLLOWUPS

Session-scoped reminders. Items resolved during the next session should be removed.

## Open

- [ ] Wire SSL config for Aliyun RDS connection (set `?sslmode=require` in prod DSN; ADR 004 §6 deadline: pre-Stage-2)
- [ ] Narrow RDS firewall whitelist from `0.0.0.0/0` to deploy IP (ADR 004 §6 blocker)
- [ ] Add `coach_profiles` migration and augment `Database` type
- [ ] Add `student_profiles` migration and augment `Database` type
- [ ] Add profile fields on `users` for `/me` PATCH or onboarding (`name`, `avatar_url`, `gender`, `birth_date`, `height_cm`, `weight_kg`, `unit_system`)
- [ ] Add multi-device refresh tracking with a dedicated `refresh_tokens` table
- [ ] Decide between hand-rolled `Database` types and `kysely-codegen` once the schema crosses ~10 tables
- [ ] Stand up docker-compose for local Postgres 17 once integration tests need a real DB
- [ ] Add a `db.test.ts` integration suite when the first real query lands (will need a service container in CI)
- [ ] Revisit JWT algorithm (HS256 → RS256) if a second verifier appears (e.g. admin web app)

## Done (resolved this session)

- [x] Bootstrap repo scaffold (specs/000-bootstrap)
- [x] First migration: define `users` table; augment `Database` type in `src/db/types.ts` (specs/001-auth)
