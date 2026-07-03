# CLAUDE.md — Engineer Context

This file is the primary onboarding doc for any Claude session working on this repo.

> **当前阶段 — TestFlight 内测运行期(2026-06-27 起)**
>
> `staging` **即生产服务分支**:push `staging` 触发 GitHub Actions 构建并推 ACR 镜像,供阿里云 SAE 拉取部署(流程见 README「Deploy & Migrate runbook」)。没有独立的 `main` / 生产分支。
>
> **允许**(内测期):
>
> - 有 `specs/NNN-*/SPEC.md` 触发的实装 —— 含埋点 **008-analytics-events**(iOS 043-analytics 消费的 `POST /events` + `GET /events/config`)的落地
> - Bugfix / 回归修复
> - Catalog(`db/seed` + `exercises` 表)数据修正
> - Security / dependency CVE 修复
>
> **不允许**:
>
> - 无 spec 触发的投机 feature
> - "clean up before V1" 式的投机 refactor
> - V0.2+ 净增量范围(仍冻结;教练驾驶舱等,权威在 `~/Brain/wiki/projects/MeetPR/`)
>
> **evaluation-workflow**(教练评估期:`0011`/`0012` 迁移 + `src/routes/evaluations.ts`)已建成但**封存休眠** —— 注入测试绑定带 `skip_evaluation: true` 关运行时;代码保留,defer ≠ delete,别删。
>
> **历史(已实装,合入 `staging`,服务内测)**:V0 = `001-auth` + `002-coach-planning-crud`;V0.1 = `003-student-actions` / `004-attachment-upload` / `005-bind-eval-profile` / `006-readiness` / `007-video-setlog-link`。逐项 SPEC 见 `specs/`。

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
