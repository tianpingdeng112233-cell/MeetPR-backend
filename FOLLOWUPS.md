# FOLLOWUPS

Session-scoped reminders. Items resolved during the next session should be removed.

## Open

- [ ] Wire SSL config for Aliyun RDS connection (set `?sslmode=require` in prod DSN; ADR 004 §6 deadline: pre-Stage-2)
- [ ] Narrow RDS firewall whitelist from `0.0.0.0/0` to deploy IP (ADR 004 §6 blocker)
- [ ] First migration: define `users`, `coach_profiles`, `student_profiles` tables; augment `Database` type in `src/db/types.ts`
- [ ] Decide between hand-rolled `Database` types and `kysely-codegen` once the schema crosses ~10 tables
- [ ] Stand up docker-compose for local Postgres 17 once integration tests need a real DB
- [ ] Add a `db.test.ts` integration suite when the first real query lands (will need a service container in CI)
- [ ] Revisit JWT algorithm (HS256 → RS256) if a second verifier appears (e.g. admin web app)

## Done (resolved this session)

- [x] Bootstrap repo scaffold (specs/000-bootstrap)
