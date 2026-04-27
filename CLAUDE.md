# CLAUDE.md — Engineer Context

This file is the primary onboarding doc for any Claude session working on this repo.

## Project

MeetPR backend service. V1 scope: REST API for coach / student workflows, training plan management, set logging, simple auth.

## Stack

| Layer      | Choice                                                                           |
| ---------- | -------------------------------------------------------------------------------- |
| Runtime    | Node.js 22 LTS                                                                   |
| Language   | TypeScript 5.7 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Web        | Express 4 + helmet + cors + express-rate-limit                                   |
| Validation | zod                                                                              |
| DB         | PostgreSQL 17 (Aliyun RDS) via `pg` + Kysely (SQL builder)                       |
| Auth       | JWT (HS256) dual-token + bcrypt 10 rounds                                        |
| Logging    | pino + pino-http                                                                 |
| Config     | dotenv (dev/test only) + zod-validated env                                       |
| Tests      | vitest + supertest                                                               |

## Hard rules

1. **No ORM.** Per ADR 004 §2. Kysely is permitted because it is a _SQL builder_ — it doesn't manage migrations, doesn't generate types from runtime schema, doesn't hide SQL semantics. If anyone proposes Prisma, Drizzle, TypeORM, MikroORM, or similar — point them at the ADR. The `Database` interface in `src/db/types.ts` is hand-augmented per migration.
2. **Hand-managed migrations.** SQL files in `db/migrations/<NNN>-<name>.sql`. No tooling-managed migrations.
3. **DATE-as-text.** All `DATE` columns must be returned as strings to avoid timezone drift. The pg type parser for OID 1082 is registered globally in `src/db/pool.ts`. Don't unregister it.
4. **No Apple-specific code.** No Apple Sign-In, no APNs, no MPS bindings. V1 doesn't need it.
5. **`dotenv` is dev-only.** Production reads env from the SAE runtime. The only place `dotenv` is loaded is `src/server.ts`, gated on `NODE_ENV !== 'production'`. Don't add it elsewhere.
6. **Never bypass hooks.** No `git commit --no-verify`. Fix the lint/format issue.
7. **Secrets are pointers.** The real DATABASE_URL password and JWT secrets live in the password manager. `.env.example` only contains placeholders. See `~/Brain/wiki/projects/MeetPR/secrets-pointer.md`.

## Code standards

- One responsibility per module. Composition functions over classes.
- Dependency injection via factory functions: `createApp({ config, logger, db })`. No top-level singletons in `src/` except in `server.ts`.
- Error envelopes are JSON: `{ error: '<machine_code>', ...details }`. Never leak stack traces to clients.
- Log with structured fields: `logger.info({ field: value }, 'event_name')`. Never string-concat into log messages.
- Tests use real instances where possible. Mock only at network/DB boundaries.

## Spec workflow

Every non-trivial change starts with a `specs/NNN-slug/SPEC.md`. See `specs/README.md`.

## Architecture decisions

Live in `~/Brain/wiki/projects/MeetPR/decisions/`. ADRs are immutable once accepted.

## Git conventions

- Branches: `staging` for in-progress, `main` for reviewed
- Commit subject: imperative mood, conventional prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
- One logical change per commit when possible
- No force-push to `main`
