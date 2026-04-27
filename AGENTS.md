# AGENTS.md — Implementer Rules

For non-Claude-Code agents (Codex, etc.) executing tasks in this repo.

## Roles

- **Engineer (Claude)** — reads SPEC, designs, reviews
- **Implementer (Codex / agent)** — writes code per SPEC, opens PR, addresses review

## Startup checklist

Before touching any file:

1. Read the linked `specs/NNN-slug/SPEC.md`. Status must be `InProgress`.
2. `pnpm install` (installs the husky hook via the `prepare` script)
3. `pnpm typecheck && pnpm lint && pnpm test` — confirm baseline is green
4. Create a feature branch off `staging`

## During implementation

- Stay inside the spec scope. Out-of-scope changes go in a follow-up SPEC.
- Run `pnpm test` frequently (target every 5–10 minutes of work).
- Don't add business logic to scaffolding files (`app.ts`, `server.ts`, `config.ts`) without coordination.
- Don't change ADR-mandated choices (no ORM, no Apple-specific code, etc.).

## Hard rules

- ❌ Never `git commit --no-verify`
- ❌ Never `git push --force` to `main`
- ❌ Never edit `~/Brain/wiki/` from this repo
- ❌ Never commit `.env` (gitignored, but verify)
- ❌ Never log secrets, JWTs, or passwords (pino has redact paths configured)

## Before opening a PR

- All gates pass: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
- PR description links the spec
- Verification checklist in the PR template is filled out
