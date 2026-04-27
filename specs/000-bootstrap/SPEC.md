# 000-bootstrap

**Status:** Done
**Date:** 2026-04-27

## Goal

Initialize the MeetPR-backend repository with a minimum-viable Node.js + TypeScript scaffold that builds, lints, and passes tests. Stub all required endpoints; no business logic.

## Scope

### Tooling

- pnpm 9 + Node 22 LTS
- TypeScript 5.7 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- ESLint 9 flat config + `typescript-eslint` strict-type-checked + `eslint-config-prettier`
- Prettier 3
- Vitest 2 + supertest 7
- Husky 9 + lint-staged 15
- GitHub Actions: separate `lint` and `build-test` jobs on `ubuntu-24.04`

### Runtime stack (per ADR 004)

- Express 4 + helmet + cors + express-rate-limit + zod
- pg (native driver) + Kysely (SQL builder; not an ORM — satisfies ADR mandate)
- jsonwebtoken (HS256) + bcrypt
- pino + pino-http (structured logging)
- dotenv (loaded only when `NODE_ENV !== 'production'`)

### Endpoints (all return 501 stub or 401 auth-rejected)

- `GET /health` — 200 (free, for liveness probes)
- `POST /auth/register|login|refresh`
- `GET /me` (auth required)
- `GET /coach/dashboard|students`, `POST /coach/plans` (auth required)
- `GET /student/plan`, `POST /student/sets` (auth required)

### Code-quality gates (must all pass before commit)

- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test`
- `pnpm build`

## Out of scope

- Apple Sign-In (deferred per ADR 004)
- MPS / video transcoding (Stage 3+)
- Real DB schema / migrations (no DDL committed)
- Real auth, registration, or session logic (route bodies are stubs only)
- Integration tests against a Postgres service container

## Verification

End-to-end smoke:

```
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
node dist/server.js  # starts; /health returns 200; /me returns 401
```
