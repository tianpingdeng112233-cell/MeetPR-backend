# CLAUDE.md — Engineer Context

This file is the primary onboarding doc for any Claude session working on this repo.

> **Status(2026-08-03)**:TestFlight 内测期,backend 随时可独立部署。`staging` 是集成分支(默认分支,PR 都开向它),`main` 收已 review 的内容。Feature 工作由 iOS / plan-web spec 触发,走 `specs/NNN-slug/SPEC.md` 流程;仍不做无 spec 触发的投机性 feature 与 speculative refactor。迁移纪律:迁移号开工现场核实,已应用状态以 `db/MIGRATIONS-APPLIED.md` 账本为准,合并后必须部署 staging(严禁「只合不部署」)。

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
4. **Apple-specific code needs a spec trigger.** APNs is in scope and implemented: `src/services/apns.ts` client, push consumer, `device_tokens` table(0042); spec 032(WebSocket realtime channel, PR #190)已合入,spec 033(六类事件推送, PR #191)在途。Apple Sign-In 和 MPS bindings 仍未实装,等对应 spec 触发再做。
5. **`dotenv` is dev-only.** Production reads env from the SAE runtime. The only place `dotenv` is loaded is `src/server.ts`, gated on `NODE_ENV !== 'production'`. Don't add it elsewhere.
6. **Never bypass hooks.** No `git commit --no-verify`. Fix the lint/format issue.
7. **Secrets are pointers.** The real DATABASE_URL password and JWT secrets live in the password manager. `.env.example` only contains placeholders. See `~/Brain/wiki/projects/MeetPR/secrets-pointer.md`.
8. **Backward compatibility with live clients.** Every change must keep the currently-shipped iOS/plan-web clients working: additive-only migrations, new behavior behind env gates defaulting to legacy-safe (e.g. `FORCE_HTTPS=false`, `AUTH_ALLOW_LEGACY_TOKENS=true`), no breaking changes to existing response shapes. This is what lets the backend deploy independently, any time, without coordinating an app release. Breaking a live client requires an explicit David sign-off and a client-first migration plan.

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
