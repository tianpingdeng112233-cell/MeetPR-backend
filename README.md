# MeetPR Backend

Backend service for the MeetPR coaching app. Node.js 22 + TypeScript + Express + Postgres (via Kysely).

## Local setup

```bash
# Install pnpm via corepack (one-time)
corepack enable pnpm

# Install dependencies (also installs the husky pre-commit hook)
pnpm install

# Copy and edit env
cp .env.example .env

# Run dev server
pnpm dev
```

## Scripts

| Command             | What                    |
| ------------------- | ----------------------- |
| `pnpm dev`          | tsx watch mode          |
| `pnpm build`        | Compile to `dist/`      |
| `pnpm start`        | Run the compiled server |
| `pnpm typecheck`    | `tsc --noEmit`          |
| `pnpm lint`         | ESLint                  |
| `pnpm format:check` | Prettier check          |
| `pnpm format`       | Prettier write          |
| `pnpm test`         | Vitest (single run)     |
| `pnpm test:watch`   | Vitest (watch)          |

## Endpoints

The authoritative route list is **`src/routes/index.ts`** (`mountRoutes`) — read it there, not here. Most routes are implemented and serving the TestFlight beta; protected routes return `401 unauthorized` without a valid Bearer token. Route groups:

| Prefix           | What                                                                              | Auth     |
| ---------------- | --------------------------------------------------------------------------------- | -------- |
| `GET /health`    | Liveness                                                                          | —        |
| `/auth`          | register / login / refresh                                                        | —        |
| `/plans`         | Coach plan CRUD                                                                   | required |
| `/students/*`    | Student-scoped: plans, sets, readiness, feedback, evaluations, onboarding, videos | required |
| `/bind-requests` | Student side of coach↔student binding                                             | required |
| `/exercises`     | Exercise catalog                                                                  | required |
| `/sets`          | Set logs                                                                          | required |
| `/feedback`      | Feedback records                                                                  | required |
| `/coach/*`       | Coach-scoped: feedback, invite-codes, bind-requests, evaluations, one-rm          | required |
| `/uploads`       | OSS multipart upload (video attachments)                                          | required |

**Remaining `501 not_implemented` stubs** (the only ones left; everything else is live):

- `GET /me` (`src/routes/me.ts`)
- `GET /coach/dashboard` (`src/routes/coach.ts`)
- `POST /student/sets` (`src/routes/student.ts`)

`POST /events` (+ `GET /events/config`) is **specced but not yet implemented** — see `specs/008-analytics-events/SPEC.md`. No route is mounted yet.

## Deploy & Migrate runbook

`staging` is the production service branch. Deploy and schema changes are two separate manual steps.

**Deploy (code):**

1. Merge/push to `staging`. GitHub Actions builds the image and pushes it to Aliyun ACR.
2. **Manually** trigger a re-deploy in Aliyun SAE so it pulls the new image. (SAE does not auto-pull on ACR push.)

**Migrate (schema):** the repo has **no migration runner** — SQL is applied by hand via `psql` against the Aliyun RDS instance (see CLAUDE.md Hard rule 2 for how to allocate the number).

**Standard order when a change ships both code and a migration: migrate first, verify, then re-deploy.**

1. Apply the new `db/migrations/<NNNN>-*.sql` to RDS via `psql`.
2. Verify (`\d <table>`, indexes, a smoke query).
3. Then trigger the SAE re-deploy so the new code meets the already-migrated schema.

Doing it in this order means the new code never hits a schema that lacks its columns.

## Knowledge base

The PRD, ADRs, and architecture decisions live in the Obsidian vault at:
`~/Brain/wiki/projects/MeetPR/`

Key docs:

- `~/Brain/wiki/projects/MeetPR/index.md` — entry point
- `~/Brain/wiki/projects/MeetPR/decisions/004-backend-selection.md` — backend stack ADR
- `~/Brain/wiki/projects/MeetPR/secrets-pointer.md` — pointer to credentials in password manager

## Engineering rules

- `CLAUDE.md` — engineer context, constraints, hard rules
- `AGENTS.md` — implementer (Codex) rules
- `FOLLOWUPS.md` — session reminders
- `specs/` — one SPEC.md per PR

## License

Proprietary. Copyright 2026 David Deng. All rights reserved.
