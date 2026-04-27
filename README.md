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

## Endpoints (V1 stubs)

All return `501 not_implemented` for now. Protected routes return `401 unauthorized` when no valid Bearer token is provided.

| Method | Path             | Auth     |
| ------ | ---------------- | -------- |
| GET    | /health          | —        |
| POST   | /auth/register   | —        |
| POST   | /auth/login      | —        |
| POST   | /auth/refresh    | —        |
| GET    | /me              | required |
| GET    | /coach/dashboard | required |
| GET    | /coach/students  | required |
| POST   | /coach/plans     | required |
| GET    | /student/plan    | required |
| POST   | /student/sets    | required |

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
