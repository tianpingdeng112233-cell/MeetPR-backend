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

## API and deployment

The service implements authentication, coach/student workflows, plans, set logs, uploads, chat, and notifications. Route registration lives in [`src/routes/`](src/routes/); request, response, and authorization contracts live in the corresponding [`specs/`](specs/). Protected routes enforce authentication and resource ownership.

Coach plan shifting extends the existing `POST/DELETE /plans/:id/shift` routes. Its `COACH_PLAN_SHIFT_ENABLED` gate defaults to `false`; the legacy student path remains compatible. Before enabling the coach path, follow [spec 045](specs/045-coach-plan-shift/SPEC.md) and the [0070 verification and rollout notes](docs/verification-0070-pg17-2026-09-14.md).

`staging` is the integration branch. A merge does not apply database migrations or deploy an image. Deployment requires the exact SHA image to exist in the registry and the required migrations to be applied; [`deploy-staging.yml`](.github/workflows/deploy-staging.yml) then rolls that image. Record actual migration and deployment results in [`db/MIGRATIONS-APPLIED.md`](db/MIGRATIONS-APPLIED.md); the [global ledger](db/MIGRATIONS-APPLIED-GLOBAL.md) tracks its environment separately.

## Knowledge base

The PRD, ADRs, and architecture decisions live in the Obsidian vault at:
`~/Brain/wiki/projects/MeetPR/`

Key docs:

- `~/Brain/wiki/projects/MeetPR/index.md` — entry point
- `~/Brain/wiki/projects/MeetPR/decisions/004-backend-selection.md` — backend stack ADR
- `~/Brain/wiki/projects/MeetPR/secrets-pointer.md` — pointer to credentials in password manager

## Engineering rules

- `CLAUDE.md` — engineer context, constraints, hard rules
- `AGENTS.md` — repository engineering rules
- `FOLLOWUPS.md` — session reminders
- `specs/` — one SPEC.md per PR

## License

Proprietary. Copyright 2026 David Deng. All rights reserved.
